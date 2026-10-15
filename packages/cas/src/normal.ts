/**
 * The rule table of RFC §7 and the readable normal form, shared by
 * `simplify` and the derivative verbs: the rational-function normal form plus
 * the kernel rules, applied bottom-up to a fixed point, printed in the
 * readable normal form (RFC §5.4).
 *
 * Every rewrite keeps the value wherever the input is defined and the
 * caller's assumptions hold. A rewrite that would change the value somewhere
 * the input is defined runs only when the sign oracle proves it safe; a
 * restriction a rewrite removes comes back in `conditions` (RFC §6). Anything
 * not in the table is left alone. Coefficients live in ℚ[π, e] with π and e
 * treated as algebraically independent (see `constants.ts`).
 *
 * Internal module; `simplify` is re-exported by `@arki/cas/simplify`.
 */
import type { Node, Span } from '@arki/expr';
import { DivisionByZeroError } from '@arki/math/errors';
import { Rational } from '@arki/math/rational';

import type { Domain } from './conditions.js';
import type { Context, Generator, RatFun } from './context.js';
import type { CasResult, Condition } from './core.js';
import type { Poly, Term } from './poly.js';
import type { Claim } from './sign.js';
import { lostConditions, mergeConditions } from './conditions.js';
import { rationalValue } from './context.js';
import { binary, Emitter, exprOf, numberNode, product, textOf } from './emit.js';
import {
  constant,
  constantValue,
  degreeIn,
  derivativeIn,
  divideExact,
  EMPTY,
  fromTerm,
  gcd,
  generator,
  generators,
  isZero,
  maxDegree,
  multiply,
  negate,
  normalized,
  ONE,
  polyKey,
  polySqrt,
  rationalContent,
  rationalSqrt,
  scale,
} from './poly.js';
import { kernelValue } from './read.js';
import { holds, SignOracle } from './sign.js';

/** The rule ids of RFC §7, in table order. The same ids label simplification steps in a derivation. */
export type SimplifyRule =
  | 'fold'
  | 'expand'
  | 'collect'
  | 'cancel'
  | 'integer-powers'
  | 'fractional-powers'
  | 'sqrt-of-square'
  | 'square-of-sqrt'
  | 'exp-ln'
  | 'ln-exp'
  | 'exp-product'
  | 'abs-sign'
  | 'parity'
  | 'special-values'
  | 'factor-out';

export type SimplifyResult = CasResult & {
  /** The rules that changed something, in table order. */
  readonly applied: readonly SimplifyRule[];
};

export const RULES: readonly SimplifyRule[] = Object.freeze([
  'fold',
  'expand',
  'collect',
  'cancel',
  'integer-powers',
  'fractional-powers',
  'sqrt-of-square',
  'square-of-sqrt',
  'exp-ln',
  'ln-exp',
  'exp-product',
  'abs-sign',
  'parity',
  'special-values',
  'factor-out',
]);

/** `f(-u) = -f(u)` over the reals. expr defines `acsc`, `acot`, `acsch` and `acoth` through `1/u`, so they are odd too. */
const ODD: ReadonlySet<string> = new Set([
  'sin',
  'tan',
  'cot',
  'csc',
  'asin',
  'atan',
  'acsc',
  'acot',
  'sinh',
  'tanh',
  'coth',
  'csch',
  'asinh',
  'atanh',
  'acsch',
  'acoth',
  'cbrt',
  'sign',
]);
/** `f(-u) = f(u)` over the reals. */
const EVEN: ReadonlySet<string> = new Set(['cos', 'sec', 'cosh', 'sech', 'abs']);

/** Kernels built by a rewrite have no place in the input. */
const NOWHERE: Span = { start: 0, end: 0 };
const HALF = Rational.fromParts(1n, 2n);

/** Passes to a fixed point. Each rule shrinks or reorders the term, so a handful suffice; fuel is the backstop. */
const MAX_PASSES = 8;

type Kernel = Extract<Generator, { readonly kind: 'kernel' }>;

/** `[g, m]` when `r` is exactly `g^m` (coefficient 1, denominator 1), else `undefined`. */
function solePower(r: RatFun): readonly [number, number] | undefined {
  if (constantValue(r.den)?.eq(ONE) !== true || r.num.size !== 1) return undefined;
  const [term] = r.num.values();
  const ids = term?.c.eq(ONE) === true ? term.m.flatMap((e, g) => (e === 0 ? [] : [[g, e] as const])) : [];
  return ids.length === 1 ? ids[0] : undefined;
}

/** The generator `r` is, exactly (coefficient 1, exponent 1), else `undefined`. */
function soleGenerator(r: RatFun): number | undefined {
  const power = solePower(r);
  return power?.[1] === 1 ? power[0] : undefined;
}

/** The root degree of `sqrt`, `cbrt` and `nthRoot` kernels, else `undefined`. */
function rootDegree(gen: Kernel): number | undefined {
  if (gen.fn === 'sqrt' || (gen.fn === 'nthRoot' && gen.args.length === 1)) return 2;
  if (gen.fn === 'cbrt') return 3;
  const n = gen.fn === 'nthRoot' && gen.args[1] !== undefined ? rationalValue(gen.args[1]) : undefined;
  return n?.isInteger() === true && n.numerator >= 2n && n.numerator <= 1000n ? Number(n.numerator) : undefined;
}

export class Simplifier {
  readonly applied = new Set<SimplifyRule>();
  /** Variables whose assumptions a rewrite relied on, in order. */
  readonly assumed = new Set<string>();
  private readonly ctx: Context;
  private readonly plain: SignOracle;
  private readonly withAssumptions: SignOracle | undefined;
  private readonly values = new Map<number, RatFun>();
  private readonly argValues = new Map<number, readonly RatFun[]>();
  private readonly order: Emitter;
  /** The rules this run may use; `undefined` allows all. A derivation switches them on one by one to show each as a step. */
  private readonly rules: ReadonlySet<SimplifyRule> | undefined;

  constructor(ctx: Context, rules?: ReadonlySet<SimplifyRule>) {
    this.ctx = ctx;
    this.rules = rules;
    this.order = new Emitter(ctx, undefined, true);
    this.plain = new SignOracle(ctx, new Map());
    this.withAssumptions = ctx.assumptions.size === 0 ? undefined : new SignOracle(ctx, ctx.assumptions);
  }

  /**
   * True when `u` prints with a leading minus: the first printed terms of its
   * numerator and denominator have opposite signs. `f(-u)` is rewritten as
   * `±f(u)` by this test, which follows the printed order, so the choice is
   * the same on every run (the print order is a monomial order, so the sign
   * of a product's first term is the product of the factors' signs).
   */
  private isNegated(u: RatFun): boolean {
    const top = this.order.firstTerm(u.num)?.c.isNegative() === true;
    const bottom = this.order.firstTerm(u.den)?.c.isNegative() === true;
    return top !== bottom;
  }

  private allows(rule: SimplifyRule): boolean {
    return this.rules?.has(rule) ?? true;
  }

  private note(rule: SimplifyRule): void {
    this.applied.add(rule);
  }

  /** Proven from the expression alone, or from the caller's assumptions (then recorded). Unknown proves nothing. */
  private prove(r: RatFun, claim: Claim): boolean {
    if (holds(this.plain.value(r).signs, claim)) return true;
    const fact = this.withAssumptions?.value(r);
    if (fact === undefined || !holds(fact.signs, claim)) return false;
    for (const name of fact.names) this.assumed.add(name);
    return true;
  }

  /** The value simplified to a fixed point. */
  value(r: RatFun): RatFun {
    let current = r;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      this.prepare(current);
      const next = this.substitute(current);
      if (polyKey(next.num) === polyKey(current.num) && polyKey(next.den) === polyKey(current.den)) return next;
      current = next;
    }
    return current;
  }

  /** Simplifies every kernel `r` reaches, innermost first, so `generatorValue` never recurses deeply. */
  private prepare(r: RatFun): void {
    const reached = new Set<number>();
    const stack = [...generators(r.num), ...generators(r.den)];
    for (let g = stack.pop(); g !== undefined; g = stack.pop()) {
      if (reached.has(g)) continue;
      reached.add(g);
      const gen = this.ctx.generators[g];
      if (gen?.kind === 'kernel')
        for (const arg of gen.args) stack.push(...generators(arg.num), ...generators(arg.den));
    }
    for (const g of [...reached].sort((a, b) => a - b)) this.generatorValue(g);
  }

  private generatorValue(g: number): RatFun {
    const known = this.values.get(g);
    if (known !== undefined) return known;
    const gen = this.ctx.generators[g];
    const out = gen?.kind === 'kernel' ? this.kernel(gen.fn, this.args(g, gen)) : this.ctx.generatorValue(g);
    this.values.set(g, out);
    return out;
  }

  /** `[u, q]` for a kernel that is a rational power of `u`: `u^q`, and `sqrt(u)` as `u^(1/2)` (one value). */
  private rationalPower(g: number, gen: Kernel): readonly [RatFun, Rational] | undefined {
    const [u, exponent] = this.args(g, gen);
    if (u === undefined) return undefined;
    if (gen.fn === 'sqrt') return [u, HALF];
    const q = gen.fn === '^' && exponent !== undefined ? rationalValue(exponent) : undefined;
    return q === undefined ? undefined : [u, q];
  }

  private args(g: number, gen: Kernel): readonly RatFun[] {
    const known = this.argValues.get(g);
    if (known !== undefined) return known;
    const out = gen.args.map(arg => this.substitute(arg));
    this.argValues.set(g, out);
    return out;
  }

  /** One pass: each generator replaced by its simplified value, with the monomial rules. */
  private substitute(r: RatFun): RatFun {
    const ctx = this.ctx;
    const num = this.poly(r.num);
    if (constantValue(r.den) !== undefined) return this.valueRules(num);
    const den = this.poly(r.den);
    if (isZero(den.num)) throw new DivisionByZeroError('cas: division by zero');
    return this.valueRules(
      ctx.quotient(multiply(num.num, den.den, ctx.budget), multiply(num.den, den.num, ctx.budget)),
    );
  }

  private poly(p: Poly): RatFun {
    const ctx = this.ctx;
    if (![...generators(p)].some(g => ctx.generators[g]?.kind === 'kernel')) return ctx.fromPoly(p);
    let sum: RatFun | undefined;
    for (const term of p.values()) {
      const t = this.term(term);
      sum = sum === undefined ? t : ctx.add(sum, t);
    }
    return sum ?? ctx.fromPoly(EMPTY);
  }

  private pow(r: RatFun, n: number): RatFun {
    return n === 1 ? r : n === 0 ? this.ctx.fromPoly(constant(ONE)) : this.ctx.power(r, n);
  }

  /**
   * `u^r`: a polynomial power for an integer `r`; for a half-integer `r = k/2`
   * the reduced power of `sqrt(u)` that `square-of-sqrt` keeps,
   * `u^((k - 1)/2)·sqrt(u)`; else the kernel `u^r` (through the rules).
   */
  private raise(u: RatFun, r: Rational): RatFun {
    if (r.isInteger()) return this.pow(u, Number(r.numerator));
    if (r.denominator === 2n) return this.times(this.pow(u, Number((r.numerator - 1n) / 2n)), this.sqrt('sqrt', u));
    return this.kernel('^', [u, this.ctx.fromPoly(constant(r))]);
  }

  /**
   * One term c·∏ gᵉ. Monomial rules: `sqrt(u)^2 → u` (`square-of-sqrt`),
   * `(u^(p/q))^k → u^(kp/q)` for an integer kp/q (`integer-powers`),
   * `exp(a)^m·exp(b)^n → exp(m·a + n·b)` (`exp-product`), and same-base
   * fractional powers combined when the base is proven positive
   * (`fractional-powers`).
   */
  private term(term: Term): RatFun {
    const ctx = this.ctx;
    const hasKernel = term.m.some((e, g) => e > 0 && ctx.generators[g]?.kind === 'kernel');
    if (!hasKernel) return ctx.fromPoly(fromTerm(term.m, term.c));
    ctx.budget.spend(1);
    const factors: RatFun[] = [];
    // Fractional powers `b^(p/q)` grouped by their base generator b.
    const groups = new Map<number, { plain: number; parts: { g: number; e: number; q: Rational }[] }>();
    const grouped = new Set<number>();
    for (const [g, e] of term.m.entries()) {
      const gen = ctx.generators[g];
      // `sqrt(u)` joins only at power 1: its higher powers are `square-of-sqrt`'s.
      if (e === 0 || gen?.kind !== 'kernel' || (gen.fn === 'sqrt' && e > 1)) continue;
      const [base, q] = this.rationalPower(g, gen) ?? [];
      const b = base === undefined ? undefined : soleGenerator(base);
      if (q === undefined || b === undefined || q.times(e).isInteger()) continue;
      const group = groups.get(b) ?? { plain: 0, parts: [] };
      group.parts.push({ g, e, q });
      groups.set(b, group);
      grouped.add(g);
    }
    let expSum: RatFun | undefined;
    let expCount = 0;
    let expLone: number | undefined;
    for (const [g, e] of term.m.entries()) {
      if (e === 0 || grouped.has(g)) continue;
      const gen = ctx.generators[g];
      const group = groups.get(g);
      if (group !== undefined) {
        group.plain = e;
        continue;
      }
      if (gen?.kind !== 'kernel') {
        factors.push(this.pow(this.generatorValue(g), e));
        continue;
      }
      const root = rootDegree(gen);
      const [u, exponent] = this.args(g, gen);
      if (root !== undefined && e >= root && u !== undefined && this.allows('square-of-sqrt')) {
        this.note('square-of-sqrt');
        factors.push(this.pow(u, Math.floor(e / root)));
        if (e % root > 0) factors.push(this.pow(this.generatorValue(g), e % root));
        continue;
      }
      const q = gen.fn === '^' && exponent !== undefined ? rationalValue(exponent) : undefined;
      if (q !== undefined && u !== undefined && q.times(e).isInteger() && this.allows('integer-powers')) {
        this.note('integer-powers');
        factors.push(this.pow(u, Number(q.times(e).numerator)));
        continue;
      }
      const value = this.generatorValue(g);
      const exp = soleGenerator(value);
      const expGen = exp === undefined ? undefined : ctx.generators[exp];
      const a = expGen?.kind === 'kernel' && expGen.fn === 'exp' ? expGen.args[0] : undefined;
      if (a !== undefined && this.allows('exp-product')) {
        const part = { num: scale(a.num, Rational.from(e)), den: a.den };
        expSum = expSum === undefined ? part : ctx.add(expSum, part);
        expCount += e;
        expLone = exp;
        continue;
      }
      factors.push(this.pow(value, e));
    }
    if (expSum !== undefined && expLone !== undefined) {
      if (expCount > 1) {
        this.note('exp-product');
        factors.push(this.kernel('exp', [expSum]));
      } else {
        factors.push(this.generatorValue(expLone));
      }
    }
    for (const [b, group] of groups) factors.push(...this.fractional(b, group));
    let value: RatFun | undefined;
    for (const f of factors) value = value === undefined ? f : ctx.multiply(value, f);
    if (value === undefined) return ctx.fromPoly(constant(term.c));
    return { num: scale(value.num, term.c), den: value.den };
  }

  /** `b^n · b^(p/q) · …` as one power when b is proven positive, else the factors unchanged. */
  private fractional(b: number, group: { plain: number; parts: { g: number; e: number; q: Rational }[] }): RatFun[] {
    const base = this.generatorValue(b);
    const separate = (): RatFun[] => [
      ...(group.plain > 0 ? [this.pow(base, group.plain)] : []),
      ...group.parts.map(part => this.pow(this.generatorValue(part.g), part.e)),
    ];
    const pieces = group.parts.length + (group.plain > 0 ? 1 : 0);
    // Only square roots (`x·sqrt(x)`): that is already the reduced form, nothing to combine.
    const roots = group.parts.every(part => part.q.eq(HALF));
    if (
      (pieces < 2 && group.parts.every(part => part.e === 1)) ||
      roots ||
      !this.allows('fractional-powers') ||
      !this.prove(base, 'positive')
    )
      return separate();
    this.note('fractional-powers');
    let total = Rational.from(group.plain);
    for (const part of group.parts) total = total.plus(part.q.times(part.e));
    return [this.raise(base, total)];
  }

  /**
   * Value-level rules: `abs(u)/u → sign(u)`, `u/sqrt(u) → sqrt(u)` (`square-of-sqrt`; the
   * input already needs `u > 0` there) and exponentials moved out of the denominator.
   */
  private valueRules(r: RatFun): RatFun {
    const ctx = this.ctx;
    const budget = ctx.budget;
    let q = r;
    for (const g of [...generators(q.num), ...generators(q.den)]) {
      const gen = ctx.generators[g];
      const u = gen?.kind === 'kernel' && gen.fn === 'abs' ? gen.args[0] : undefined;
      if (
        u === undefined ||
        constantValue(u.den) === undefined ||
        constantValue(u.num) !== undefined ||
        !this.allows('abs-sign')
      )
        continue;
      const a = generator(g);
      // abs(u)/u and u/abs(u) are both sign(u). Each step removes one abs(u) and one u; the degrees bound the loop.
      for (let steps = degreeIn(q.num, g) + degreeIn(q.den, g); steps > 0; steps--) {
        const [top, bottom] = [divideExact(q.num, a, budget), divideExact(q.den, u.num, budget)];
        const [n, d] =
          top === undefined || bottom === undefined
            ? [divideExact(q.num, u.num, budget), divideExact(q.den, a, budget)]
            : [top, bottom];
        if (n === undefined || d === undefined) break;
        this.note('abs-sign');
        q = this.times(ctx.quotient(n, d), this.kernel('sign', [u]));
      }
    }
    for (const g of generators(q.den)) {
      const gen = ctx.generators[g];
      const u = gen?.kind === 'kernel' && gen.fn === 'sqrt' ? gen.args[0] : undefined;
      if (u === undefined || constantValue(u.den) === undefined || !this.allows('square-of-sqrt')) continue;
      // Each step moves one sqrt(u) up and one u out; the degrees bound the loop.
      for (let steps = degreeIn(q.den, g); steps > 0; steps--) {
        const [n, d] = [divideExact(q.num, u.num, budget), divideExact(q.den, generator(g), budget)];
        if (n === undefined || d === undefined) break;
        this.note('square-of-sqrt');
        q = ctx.quotient(multiply(n, generator(g), budget), scale(d, (constantValue(u.den) ?? ONE).inverse()));
      }
    }
    for (const g of generators(q.den)) {
      const gen = ctx.generators[g];
      const a = gen?.kind === 'kernel' && gen.fn === 'exp' ? gen.args[0] : undefined;
      const k = Math.min(...Array.from(q.den.values(), t => t.m[g] ?? 0));
      if (a === undefined || k === 0 || !this.allows('exp-product')) continue;
      // exp(a) > 0 everywhere: 1/exp(a)^k is exp(-k·a).
      this.note('exp-product');
      q = this.times(
        ctx.quotient(q.num, divideExact(q.den, generator(g, k), budget) ?? q.den),
        this.exp({ num: scale(a.num, Rational.from(-k)), den: a.den }),
      );
    }
    return q;
  }

  /** a·b without recording phases: rewrites, not the input's arithmetic. */
  private times(a: RatFun, b: RatFun): RatFun {
    const budget = this.ctx.budget;
    return this.ctx.quotient(multiply(a.num, b.num, budget), multiply(a.den, b.den, budget));
  }

  /** The kernel `fn(args)` after the kernel rules; args are simplified already. */
  private kernel(fn: string, args: readonly RatFun[]): RatFun {
    const ctx = this.ctx;
    ctx.budget.spend(1);
    const [u, v] = args;
    if (u !== undefined && args.length === 1) {
      const odd = ODD.has(fn);
      if ((odd || EVEN.has(fn)) && this.isNegated(u) && this.allows('parity')) {
        this.note('parity');
        const r = this.kernel(fn, [ctx.negate(u)]);
        return odd ? ctx.negate(r) : r;
      }
      const zero = rationalValue(u)?.isZero() === true;
      switch (fn) {
        case 'sin':
        case 'tan':
        case 'cos': {
          if (!zero || !this.allows('special-values')) break;
          this.note('special-values');
          return ctx.fromPoly(fn === 'cos' ? constant(ONE) : EMPTY);
        }
        case 'exp': {
          return this.exp(u);
        }
        case 'ln':
        case 'log': {
          return this.ln(fn, u);
        }
        case 'sqrt':
        case 'nthRoot': {
          return this.sqrt(fn, u);
        }
        case 'abs': {
          return this.abs(u);
        }
      }
    }
    if (fn === '^' && u !== undefined && v !== undefined && args.length === 2) return this.power(u, v);
    return kernelValue(fn, args, NOWHERE, ctx);
  }

  /** `exp(0) → 1`, `exp(n) → e^n` (the coefficient), `exp(ln(u)) → u`. */
  private exp(u: RatFun): RatFun {
    const ctx = this.ctx;
    const c = rationalValue(u);
    if (c?.isZero() === true && this.allows('special-values')) {
      this.note('special-values');
      return ctx.fromPoly(constant(ONE));
    }
    if (c?.isInteger() === true) {
      const n = Number(c.numerator);
      ctx.budget.check('degree', Math.abs(n));
      const e = ctx.e();
      return n > 0 ? ctx.fromPoly(generator(e, n)) : ctx.quotient(constant(ONE), generator(e, -n));
    }
    const g = soleGenerator(u);
    const gen = g === undefined ? undefined : ctx.generators[g];
    if (
      gen?.kind === 'kernel' &&
      (gen.fn === 'ln' || gen.fn === 'log') &&
      gen.args.length === 1 &&
      gen.args[0] !== undefined &&
      this.allows('exp-ln')
    ) {
      this.note('exp-ln');
      return gen.args[0];
    }
    return kernelValue('exp', [u], NOWHERE, ctx);
  }

  /** `ln(1) → 0`, `ln(e) → 1`, `ln(e^k) → k`, `ln(exp(u)) → u`; `log(u)` is the natural log. */
  private ln(fn: string, u: RatFun): RatFun {
    const ctx = this.ctx;
    if (rationalValue(u)?.eq(ONE) === true && this.allows('special-values')) {
      this.note('special-values');
      return ctx.fromPoly(EMPTY);
    }
    const power = solePower(u);
    const lnRule = power?.[1] === 1 ? 'special-values' : 'ln-exp';
    if (power !== undefined && ctx.generators[power[0]]?.kind === 'e' && this.allows(lnRule)) {
      this.note(lnRule);
      return ctx.fromPoly(constant(Rational.from(power[1])));
    }
    const g = soleGenerator(u);
    const gen = g === undefined ? undefined : ctx.generators[g];
    if (gen?.kind === 'kernel' && gen.fn === 'exp' && gen.args[0] !== undefined && this.allows('ln-exp')) {
      this.note('ln-exp');
      return gen.args[0];
    }
    return kernelValue(fn, [u], NOWHERE, ctx);
  }

  /** `sqrt` of an exact rational square, and `sqrt(c·w^2) → sqrt(c)·abs(w)` for polynomial squares. */
  private sqrt(fn: string, u: RatFun): RatFun {
    const ctx = this.ctx;
    // exp(a) > 0 everywhere: sqrt(exp(a)) is exp(a/2).
    const sole = soleGenerator(u);
    const inner = sole === undefined ? undefined : ctx.generators[sole];
    const exponent = inner?.kind === 'kernel' && inner.fn === 'exp' ? inner.args[0] : undefined;
    if (exponent !== undefined && this.allows('exp-product')) {
      this.note('exp-product');
      return this.exp(ctx.multiply(exponent, ctx.fromPoly(constant(HALF))));
    }
    const c = rationalValue(u);
    if (c !== undefined) {
      const root = rationalSqrt(c);
      if (root === undefined || !this.allows('special-values')) return kernelValue(fn, [u], NOWHERE, ctx);
      this.note('special-values');
      return ctx.fromPoly(constant(root));
    }
    const top = polySqrt(u.num, ctx.budget);
    const bottom = top === undefined ? undefined : polySqrt(u.den, ctx.budget);
    if (top === undefined || bottom === undefined || !this.allows('sqrt-of-square'))
      return kernelValue(fn, [u], NOWHERE, ctx);
    this.note('sqrt-of-square');
    const w = ctx.quotient(top, bottom);
    const content = rationalContent(w.num);
    const a = this.abs({ num: scale(w.num, content.inverse()), den: w.den });
    return { num: scale(a.num, content), den: a.den };
  }

  /** `abs` of a rational; `abs(u) → u` or `-u` when the sign of `u` is proven or assumed. */
  private abs(u: RatFun): RatFun {
    const ctx = this.ctx;
    const c = rationalValue(u);
    if (c !== undefined && this.allows('special-values')) {
      this.note('special-values');
      return ctx.fromPoly(constant(c.abs()));
    }
    let w = u;
    if (this.isNegated(w) && this.allows('parity')) {
      this.note('parity');
      w = ctx.negate(w);
    }
    if (this.allows('abs-sign') && this.prove(w, 'nonnegative')) {
      this.note('abs-sign');
      return w;
    }
    if (this.allows('abs-sign') && this.prove(w, 'nonpositive')) {
      this.note('abs-sign');
      return ctx.negate(w);
    }
    return kernelValue('abs', [w], NOWHERE, ctx);
  }

  /** The kernel `base^exponent`: `exp(a)^y → exp(a·y)`; `(u^a)^q` and `(g^m)^q` multiply out when the base is proven positive. */
  private power(base: RatFun, exponent: RatFun): RatFun {
    const ctx = this.ctx;
    const q = rationalValue(exponent);
    if (q?.isInteger() === true) return this.pow(base, Number(q.numerator));
    const g = soleGenerator(base);
    const gen = g === undefined ? undefined : ctx.generators[g];
    if (gen?.kind === 'kernel' && gen.fn === 'exp' && gen.args[0] !== undefined && this.allows('exp-product')) {
      this.note('exp-product');
      return this.exp(ctx.multiply(gen.args[0], exponent));
    }
    const inner = q !== undefined && g !== undefined && gen?.kind === 'kernel' ? this.rationalPower(g, gen) : undefined;
    if (q !== undefined && inner !== undefined) {
      const [u, r] = inner;
      if (this.allows('fractional-powers') && this.prove(u, 'positive')) {
        this.note('fractional-powers');
        return this.raise(u, r.times(q));
      }
    }
    const only = solePower(base);
    if (
      q !== undefined &&
      only !== undefined &&
      only[1] > 1 &&
      this.allows('fractional-powers') &&
      this.prove(ctx.generatorValue(only[0]), 'positive')
    ) {
      this.note('fractional-powers');
      return this.raise(ctx.generatorValue(only[0]), q.times(only[1]));
    }
    // `u^(k/2)` is a power of `sqrt(u)`, as the reader builds it: one kernel for one value.
    if (q?.denominator === 2n) return this.raise(base, q);
    return kernelValue('^', [base, exponent], NOWHERE, ctx);
  }
}

/**
 * The readable normal form (RFC §5.4): the numerator expanded, with a common
 * kernel factor pulled out (`exp(x)*(cos(x) - sin(x))`); one fraction over a
 * denominator printed as a product of its factors (`(x - 1)^2`). The factors
 * are the ones the input divided by, split further by content and by
 * repeated factors (gcd with each partial derivative); the printer does not
 * call `factor`, so a denominator is never split further than that.
 */
export class Readable extends Emitter {
  pulled = false;
  private readonly context: Context;
  /** False prints the numerator without pulling out a common factor (`factor-out`). */
  private readonly factorOut: boolean;

  constructor(ctx: Context, factorOut = true) {
    super(ctx, undefined, true);
    this.context = ctx;
    this.factorOut = factorOut;
  }

  override node(r: RatFun): Node {
    if (constantValue(r.den) !== undefined) return this.numerator(r.num);
    const [num, den] = this.fractionParts(r);
    const bottom = this.denominator(den);
    return binary('/', this.numerator(bottom.negative ? negate(num) : num), bottom.node);
  }

  private numerator(p: Poly): Node {
    if (p.size < 2 || !this.factorOut) return this.polyNode(p);
    let common: number[] | undefined;
    for (const term of p.values()) {
      const m = term.m.map((e, g) => (this.context.generators[g]?.kind === 'kernel' ? e : 0));
      common = common === undefined ? m : common.map((e, g) => Math.min(e, m[g] ?? 0));
    }
    if (common?.some(e => e > 0) !== true) return this.polyNode(p);
    const rest = divideExact(p, fromTerm(common, ONE), this.context.budget);
    if (rest === undefined) return this.polyNode(p);
    this.pulled = true;
    return product([...this.monomialFactors(common), this.polyNode(rest)]);
  }

  /**
   * The denominator as a product of factors, each printed with a positive
   * first term; `negative` says the numerator takes the sign. Signs follow
   * the printed order, not generator ids, so the output is the same however
   * the input was written.
   */
  private denominator(den: Poly): { node: Node; negative: boolean } {
    // The print order is a monomial order: the sign of the product's first term is the product of the factors' signs.
    const negative = this.firstTerm(den)?.c.isNegative() === true;
    const content = rationalContent(den);
    if (!content.isInteger()) return { node: this.polyNode(negative ? negate(den) : den), negative };
    const nodes: Node[] = content.eq(ONE) ? [] : [numberNode(content.numerator.toString())];
    for (const { p, m } of this.factors(scale(den, content.inverse()))) {
      const node = this.polyNode(p);
      nodes.push(m === 1 ? node : binary('^', node, numberNode(String(m))));
    }
    return { node: product(nodes), negative };
  }

  /** Coprime refinement of `den` by the input's divisors, each factor's partial derivatives and the other factors. */
  private factors(den: Poly): { p: Poly; m: number }[] {
    const ctx = this.context;
    const limit = ctx.budget.limits.gcdDegree;
    if (maxDegree(den) > limit) return [{ p: den, m: 1 }];
    const candidates = ctx.divisors.filter(d => constantValue(d) === undefined && maxDegree(d) <= limit);
    const list: { p: Poly; m: number }[] = [{ p: den, m: 1 }];
    const settled = new Set<string>();
    const split = (i: number, by: Poly): boolean => {
      const item = list[i];
      if (item === undefined) return false;
      const g = gcd(item.p, by, ctx.budget);
      if (constantValue(g) !== undefined) return false;
      const q = divideExact(item.p, g, ctx.budget);
      if (q === undefined || constantValue(q) !== undefined) return false;
      list.splice(i, 1, { p: normalized(g), m: item.m }, { p: normalized(q), m: item.m });
      return true;
    };
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < list.length && !changed; i++) {
        const f = list[i]?.p ?? EMPTY;
        const key = polyKey(f);
        if (constantValue(f) !== undefined || settled.has(key)) continue;
        const by = [
          ...[...generators(f)].map(g => derivativeIn(f, g)),
          ...list.filter((_, j) => j !== i).map(item => item.p),
          ...candidates,
        ];
        changed = by.some(b => split(i, b));
        if (!changed) settled.add(key);
      }
    }
    // Each factor printed with a positive first term; the order follows the printed text, so it is canonical.
    const merged = new Map<string, { p: Poly; m: number; key: string }>();
    for (const { p, m } of list) {
      const f = this.firstTerm(p)?.c.isNegative() === true ? negate(p) : p;
      const key = polyKey(f);
      const order = `${ctx.isConstant(f) ? 0 : f.size === 1 ? 1 : 2}${textOf(this.polyNode(f), ctx)}`;
      merged.set(key, { p: f, m: (merged.get(key)?.m ?? 0) + m, key: order });
    }
    return [...merged.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}

/** A normalized value: `simplify`'s result, plus the simplified value for callers that keep computing with it. */
export type Normal = SimplifyResult & { readonly value: RatFun };

/**
 * `value` simplified by the rule table and printed in the readable normal
 * form. Every restriction of `domain()` (built after simplifying) the result no longer shows comes back
 * as a condition. `notes` collects the phases the arithmetic performs; pass
 * the set the input was read with. `rules` limits the rules this run may use,
 * and `factorOut: false` skips `factor-out`: a derivation switches rules on
 * one by one to show each as a step.
 */
export function normalize(
  ctx: Context,
  value: RatFun,
  domain: () => Domain,
  notes: Set<string>,
  rules?: ReadonlySet<SimplifyRule>,
  factorOut = true,
): Normal {
  ctx.notes = notes;
  const simplifier = new Simplifier(ctx, rules);
  const simplified = simplifier.value(value);
  const emitter = new Readable(ctx, factorOut);
  const result = exprOf(emitter.node(simplified), ctx);
  ctx.notes = undefined;
  const applied = RULES.filter(
    rule => notes.has(rule) || simplifier.applied.has(rule) || (rule === 'factor-out' && emitter.pulled),
  );
  const lost = lostConditions(ctx, domain(), simplified, emitter, r => simplifier.value(r));
  const assumed: Condition[] = [];
  for (const name of simplifier.assumed) {
    const assumption = ctx.assumptions.get(name);
    const id = ctx.nameId(name);
    if (assumption === undefined || id === undefined) continue;
    const variable = ctx.generatorValue(id);
    assumed.push({ subject: exprOf(emitter.node(variable), ctx), relation: assumption, reason: 'assumed' });
  }
  return { result, conditions: mergeConditions(assumed, lost), applied, value: simplified };
}
