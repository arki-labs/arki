/**
 * Domain restrictions and lost conditions (RFC §6).
 *
 * The natural domain of an input is every denominator ≠ 0 plus the
 * restrictions of its kernels: `ln`/`log` argument > 0, `log(u, b)` base > 0
 * and ≠ 1, `sqrt` and even-root arguments ≥ 0, `u^(p/q)` base ≥ 0 (> 0 for a
 * negative exponent), `asin`/`acos` 1 − u² ≥ 0, `acosh` u − 1 ≥ 0, `atanh`
 * 1 − u² > 0, `tan`/`sec` `cos(u)` ≠ 0, `cot`/`csc` `sin(u)` ≠ 0, `coth`/`csch`
 * u ≠ 0. Restrictions are collected from every kernel the input built, kept or
 * dropped, so `0*ln(x)` still knows about `x > 0`.
 *
 * A restriction is lost when the result no longer shows it. Every lost
 * restriction is returned, except one the sign oracle proves from the
 * expression alone (`x^2 + 1 ≠ 0`), which holds everywhere.
 *
 * Internal module.
 */
import { DivisionByZeroError } from '@arki/math/errors';

import type { Context, Generator, RatFun } from './context.js';
import type { Condition } from './core.js';
import type { Emitter } from './emit.js';
import type { Poly } from './poly.js';
import { rationalValue } from './context.js';
import { exprOf } from './emit.js';
import { constantValue, divideExact, gcd, generators, isZero, multiply, polyKey, rationalContent, scale, squareFreePart, subtract } from './poly.js';
import { kernelValue } from './read.js';
import { holds, SignOracle } from './sign.js';

export type Restriction = { readonly subject: RatFun; readonly relation: 'positive' | 'nonnegative' };
/** `nonzero` holds polynomials (a value's non-zero numerator); `signed` holds values with their relation. */
export type Domain = { readonly nonzero: Poly[]; readonly signed: Restriction[] };

type Kernel = Extract<Generator, { readonly kind: 'kernel' }>;

/** 1 − u² as a value. */
function oneMinusSquare(u: RatFun, ctx: Context): RatFun {
  const den = multiply(u.den, u.den, ctx.budget);
  return { num: subtract(den, multiply(u.num, u.num, ctx.budget)), den };
}

/** u − 1 as a value. */
function minusOne(u: RatFun): RatFun {
  return { num: subtract(u.num, u.den), den: u.den };
}

function kernelDomain(gen: Kernel, ctx: Context, into: Domain): void {
  const [u, v] = gen.args;
  if (u === undefined) return;
  const fn = gen.fn;
  const n = v === undefined ? undefined : rationalValue(v);
  const signed = (subject: RatFun, relation: Restriction['relation']): void => void into.signed.push({ subject, relation });
  if (fn === 'ln' || fn === 'log' || fn === 'log10' || fn === 'log2') signed(u, 'positive');
  if (fn === 'log' && v !== undefined) {
    signed(v, 'positive');
    into.nonzero.push(minusOne(v).num);
  }
  // Even roots: nthRoot(u) is sqrt(u); an odd degree is defined for every real u.
  if (fn === 'sqrt' || (fn === 'nthRoot' && (v === undefined || (n?.isInteger() === true && n.numerator % 2n === 0n)))) signed(u, 'nonnegative');
  if (fn === '^' && n !== undefined && !n.isInteger()) signed(u, n.isNegative() ? 'positive' : 'nonnegative');
  if (fn === 'asin' || fn === 'acos' || fn === 'atanh') signed(oneMinusSquare(u, ctx), fn === 'atanh' ? 'positive' : 'nonnegative');
  if (fn === 'acosh') signed(minusOne(u), 'nonnegative');
  if (fn === 'tan' || fn === 'sec' || fn === 'cot' || fn === 'csc') {
    into.nonzero.push(kernelValue(fn === 'tan' || fn === 'sec' ? 'cos' : 'sin', [u], gen.span, ctx).num);
  }
  if (fn === 'coth' || fn === 'csch') into.nonzero.push(u.num);
}

/** The input's domain: the first `divisors` divisors and the restrictions of the first `kernels` generators. */
export function inputDomain(ctx: Context, kernels = ctx.generators.length, divisors = ctx.divisors.length): Domain {
  const domain: Domain = { nonzero: ctx.divisors.slice(0, divisors), signed: [] };
  for (let g = 0; g < kernels; g++) {
    const gen = ctx.generators[g];
    if (gen?.kind === 'kernel') kernelDomain(gen, ctx, domain);
  }
  return domain;
}

/** The restrictions a value shows: its denominators and its kernels' restrictions, recursively. */
export function valueDomain(ctx: Context, r: RatFun): Domain {
  const domain: Domain = { nonzero: [r.den], signed: [] };
  const seen = new Set<number>();
  const stack = [...generators(r.num), ...generators(r.den)];
  for (let g = stack.pop(); g !== undefined; g = stack.pop()) {
    if (seen.has(g)) continue;
    seen.add(g);
    const gen = ctx.generators[g];
    if (gen?.kind !== 'kernel') continue;
    for (const arg of gen.args) {
      domain.nonzero.push(arg.den);
      stack.push(...generators(arg.num), ...generators(arg.den));
    }
    kernelDomain(gen, ctx, domain);
  }
  return domain;
}

/** `subject` scaled by a positive constant so equal restrictions print alike (`2*x - 2 ≥ 0` is `x - 1 ≥ 0`). */
function primitive(subject: RatFun): RatFun {
  if (isZero(subject.num)) return subject;
  return { num: scale(subject.num, rationalContent(subject.num).inverse()), den: subject.den };
}

/** `u` for a lone `abs(u)` with a polynomial `u`: `abs(u) ≠ 0` is `u ≠ 0`. */
function absArgument(p: Poly, ctx: Context): Poly | undefined {
  const [g, ...rest] = generators(p);
  const gen = g === undefined ? undefined : ctx.generators[g];
  const [u] = gen?.kind === 'kernel' && gen.fn === 'abs' ? gen.args : [];
  if (rest.length > 0 || p.size !== 1 || u === undefined || constantValue(u.den) === undefined) return undefined;
  return u.num;
}

/** The factors of `p` not shared with any of `visible`. */
function unshared(p: Poly, visible: readonly Poly[], ctx: Context): Poly {
  let q = p;
  for (const v of visible) {
    for (let g = gcd(q, v, ctx.budget); constantValue(g) === undefined; g = gcd(q, v, ctx.budget)) {
      q = divideExact(q, g, ctx.budget) ?? q;
    }
  }
  return q;
}

/**
 * The conditions a result carries (RFC §6): the input's restrictions it no
 * longer shows. `map` rewrites each subject the way the result was rewritten
 * (`simplify`), so a subject is compared and printed in the result's terms.
 * A subject that maps to zero means the input is defined nowhere.
 */
export function lostConditions(
  ctx: Context,
  input: Domain,
  value: RatFun,
  emitter: Emitter,
  map: (r: RatFun) => RatFun = r => r,
): Condition[] {
  const oracle = new SignOracle(ctx, new Map());
  const visible = valueDomain(ctx, value);
  // Normal forms are canonical within a call (equal kernels are one generator), so structure is a key.
  const keyOf = (r: RatFun): string => {
    const p = primitive(r);
    return `${polyKey(p.num)}/${polyKey(p.den)}`;
  };
  const nonzero = [...visible.nonzero, ...visible.signed.filter(s => s.relation === 'positive').map(s => s.subject.num)];
  // The subjects the result shows, built only if a signed restriction survives the oracle.
  let shown: Map<string, Set<string>> | undefined;
  const shownFor = (key: string): Set<string> | undefined => {
    if (shown === undefined) {
      shown = new Map();
      for (const s of visible.signed) {
        const k = keyOf(s.subject);
        shown.set(k, (shown.get(k) ?? new Set()).add(s.relation));
      }
    }
    return shown.get(key);
  };
  const out: Condition[] = [];
  const listed = new Set<string>();
  const push = (subject: Condition['subject'], relation: Condition['relation']): void => {
    const key = `${relation}:${subject.source}`;
    if (listed.has(key)) return;
    listed.add(key);
    out.push({ subject, relation, reason: 'domain' });
  };
  for (const p of input.nonzero) {
    const mapped = map(ctx.fromPoly(p)).num;
    if (isZero(mapped)) throw new DivisionByZeroError('cas: division by zero');
    const q = unshared(mapped, nonzero, ctx);
    if (ctx.isConstant(q)) continue;
    const part = squareFreePart(absArgument(q, ctx) ?? q, ctx.budget);
    if (holds(oracle.poly(part).signs, 'nonzero')) continue;
    push(exprOf(emitter.polyNode(part), ctx), 'nonzero');
  }
  for (const s of input.signed) {
    const subject = primitive(map(s.subject));
    if (holds(oracle.value(subject).signs, s.relation)) continue;
    const relations = shownFor(keyOf(subject));
    if (relations?.has('positive') === true || relations?.has(s.relation) === true) continue;
    push(exprOf(emitter.node(subject), ctx), s.relation);
  }
  // `positive` implies `nonzero` and `nonnegative`.
  const positive = new Set(out.filter(c => c.relation === 'positive').map(c => c.subject.source));
  return out.filter(c => c.relation === 'positive' || !positive.has(c.subject.source));
}
