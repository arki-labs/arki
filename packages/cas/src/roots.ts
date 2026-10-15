/**
 * `exactRoots` (RFC §8.3): closed forms for parts of degree 1 and 2, over
 * ℚ(π, e). A factor `x^k` gives the root 0; a polynomial of degree ≥ 3 is
 * split into square-free parts (Yun), and with rational coefficients each
 * part into its irreducible factors over ℚ (`factor.ts`, Zassenhaus). Parts
 * of degree ≤ 2 are solved exactly; the rest are returned as `numeric`, with
 * float coefficients for `@arki/math/polynomial` `polynomialRoots`.
 *
 * Internal module; re-exported by `@arki/cas/polynomial`.
 */
import type { Expr, Node } from '@arki/expr';
import { InvalidArgumentError } from '@arki/math/errors';
import { Rational } from '@arki/math/rational';

import type { RatFun } from './context.js';
import type { CasOptions } from './core.js';
import type { Zx } from './factor.js';
import type { Poly } from './poly.js';
import type { PolynomialForm } from './polynomial.js';
import { constantFloat, constantSign } from './constants.js';
import { Context } from './context.js';
import { CasLimitError } from './core.js';
import { binary, Emitter, exprOf } from './emit.js';
import { irreducibleFactors, squareFree } from './factor.js';
import {
  add,
  coefficientsIn,
  compareMonomials,
  constant,
  constantValue,
  degreeIn,
  derivativeIn,
  divideExact,
  EMPTY,
  fromCoefficientsIn,
  gcd,
  generators,
  isZero,
  leadingTerm,
  multiply,
  negate,
  normalized,
  ONE,
  primitiveIn,
  rationalContent,
  scale,
  subtract,
} from './poly.js';
import { inputExpr, kernelValue, read } from './read.js';

export type ExactRoots = {
  /** Closed-form roots; `real: false` for complex ones, which print with `i`. */
  readonly roots: readonly { readonly value: Expr; readonly multiplicity: number; readonly real: boolean }[];
  /** Parts with no closed form here, ascending float coefficients, for a numeric solver. */
  readonly numeric: readonly { readonly coefficients: readonly number[]; readonly multiplicity: number }[];
  /** False when `numeric` is non-empty. */
  readonly exact: boolean;
};

const AT = { start: 0, end: 0 };

/** Trial division stops at this prime bound; what is left is kept under the root (correct, maybe not fully reduced). */
const TRIAL_LIMIT = 10_000n;

function exactQuotient(a: Poly, b: Poly, ctx: Context): Poly {
  const q = divideExact(a, b, ctx.budget);
  if (q === undefined) throw new Error('cas invariant: a gcd did not divide its input');
  return q;
}

/** ⌊√n⌋ for n ≥ 0, by Newton's method. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (let y = (x + n / x) / 2n; y < x; y = (x + n / x) / 2n) x = y;
  return x;
}

/**
 * n = s²·r. After trial division by every p ≤ L = 10⁴, the cofactor has only prime
 * factors above L; below L³ = 10¹² it has at most two, so its only possible square
 * is a whole perfect square, which the isqrt check takes out. r is therefore
 * square-free whenever that cofactor is below 10¹²; above it, a square of two large
 * primes can stay under the root (the value is still exact, only less reduced).
 */
function squarePart(n: bigint, ctx: Context): readonly [bigint, bigint] {
  let s = 1n;
  // `small` collects the primes ≤ L left with exponent 1, so that `r` keeps only primes above L.
  let small = 1n;
  let r = n;
  for (let p = 2n; p <= TRIAL_LIMIT && p * p <= r; p += p === 2n ? 1n : 2n) {
    ctx.budget.spend(1);
    while (r % (p * p) === 0n) {
      r /= p * p;
      s *= p;
    }
    if (r % p === 0n) {
      r /= p;
      small *= p;
    }
  }
  const root = isqrt(r);
  return root * root === r ? [s * root, small] : [s, small * r];
}

/** The polynomial q with q² = p, if there is one (term by term, as in long division). */
function polySqrt(p: Poly, ctx: Context): Poly | undefined {
  const lead = leadingTerm(p);
  if (lead === undefined || lead.c.isNegative() || lead.m.some(e => e % 2 !== 0)) return undefined;
  const [num, den] = [isqrt(lead.c.numerator), isqrt(lead.c.denominator)];
  if (num * num !== lead.c.numerator || den * den !== lead.c.denominator) return undefined;
  const first = { m: lead.m.map(e => e / 2), c: Rational.fromParts(num, den) };
  let q = fromTerm(first.m, first.c);
  for (let steps = 0; steps <= p.size; steps++) {
    const rest = subtract(p, multiply(q, q, ctx.budget));
    const next = leadingTerm(rest);
    if (next === undefined) return q;
    const m = Array.from(
      { length: Math.max(next.m.length, first.m.length) },
      (_, g) => (next.m[g] ?? 0) - (first.m[g] ?? 0),
    );
    // The next term of q divides the remainder's lead by 2·lead(q) and is smaller than lead(q).
    if (m.some(e => e < 0) || compareMonomials(m, first.m) >= 0) return undefined;
    q = add(q, fromTerm(m, next.c.dividedBy(first.c.times(2))));
  }
  return undefined;
}

function fromTerm(m: readonly number[], c: Rational): Poly {
  let end = m.length;
  while (end > 0 && m[end - 1] === 0) end--;
  const trimmed = m.slice(0, end);
  return new Map([[trimmed.join(','), { m: trimmed, c }]]);
}

/** √m for a positive value m in ℚ[π, e]: rational squares and polynomial squares come out, the rest stays under `sqrt`. */
function sqrtOf(m: Poly, ctx: Context): RatFun {
  const content = rationalContent(m);
  const primitive = scale(m, content.inverse());
  const [s, r] = squarePart(content.numerator * content.denominator, ctx);
  const root = polySqrt(primitive, ctx);
  const multiplier = ctx.fromPoly(scale(root ?? constant(ONE), Rational.fromParts(s, content.denominator)));
  const radicand =
    root === undefined ? scale(primitive, Rational.fromParts(r, 1n)) : constant(Rational.fromParts(r, 1n));
  if (constantValue(radicand)?.eq(1) === true) return multiplier;
  return ctx.multiply(multiplier, kernelValue('sqrt', [ctx.fromPoly(radicand)], AT, ctx));
}

/** Square-free parts of f in x, with multiplicities (Yun's algorithm). */
export function squareFreeParts(f: Poly, x: number, ctx: Context): (readonly [Poly, number])[] {
  const f0 = primitiveIn(f, x, ctx.budget);
  const df = derivativeIn(f0, x);
  const a0 = gcd(f0, df, ctx.budget);
  let b = exactQuotient(f0, a0, ctx);
  let d = subtract(exactQuotient(df, a0, ctx), derivativeIn(b, x));
  const out: (readonly [Poly, number])[] = [];
  for (let i = 1; degreeIn(b, x) > 0; i++) {
    const a = gcd(b, d, ctx.budget);
    if (degreeIn(a, x) > 0) out.push([a, i]);
    const c = exactQuotient(d, a, ctx);
    b = exactQuotient(b, a, ctx);
    d = subtract(c, derivativeIn(b, x));
  }
  return out;
}

function toDense(p: Poly, x: number): Zx {
  return coefficientsIn(p, x).map(c => constantValue(c)?.numerator ?? 0n);
}

function fromDense(f: Zx, x: number): Poly {
  return fromCoefficientsIn(
    f.map(c => constant(Rational.fromParts(c, 1n))),
    x,
  );
}

function digitsOf(f: Zx): number {
  return Math.max(...f.map(c => (c < 0n ? -c : c).toString().length));
}

/**
 * The irreducible factors over ℚ of a square-free polynomial in x alone
 * (rational coefficients), each with coprime integer coefficients and a
 * positive leading coefficient. Checks `factorDegree` and `factorDigits`
 * first; lifting and recombination check their own budgets.
 */
export function rationalFactors(part: Poly, x: number, ctx: Context): Poly[] {
  const dense = toDense(normalized(part), x);
  ctx.budget.check('factorDegree', dense.length - 1);
  ctx.budget.check('factorDigits', digitsOf(dense));
  return irreducibleFactors(dense, ctx.budget).map(f => fromDense(f, x));
}

/**
 * The complete factorization over ℚ of a polynomial in x alone: irreducible
 * factors with multiplicities, up to a rational constant. The square-free
 * split uses heuristic gcds (no coefficient growth); if one gives up, the
 * remainder-sequence split of `squareFreeParts` is used instead.
 */
export function rationalFactorization(p: Poly, x: number, ctx: Context): (readonly [Poly, number])[] {
  const dense = toDense(normalized(p), x);
  ctx.budget.check('factorDigits', digitsOf(dense));
  const parts =
    squareFree(dense, ctx.budget)?.map(([f, m]) => [fromDense(f, x), m] as const) ?? squareFreeParts(p, x, ctx);
  return parts.flatMap(([part, multiplicity]) => rationalFactors(part, x, ctx).map(f => [f, multiplicity] as const));
}

/** True when every generator of `p` is `x`: its coefficients are rational. */
export function rationalIn(p: Poly, x: number): boolean {
  for (const g of generators(p)) if (g !== x) return false;
  return true;
}

/**
 * The parts `exactRoots` solves: irreducible factors over ℚ for rational
 * coefficients (so `x^4 - 5x^2 + 4` gives four linear factors), else the
 * square-free parts. A factoring budget that runs out leaves the
 * square-free part whole; it is then solved numerically.
 */
function rootParts(p: Poly, x: number, ctx: Context): (readonly [Poly, number])[] {
  if (!rationalIn(p, x)) return squareFreeParts(p, x, ctx);
  try {
    return rationalFactorization(p, x, ctx);
  } catch (error) {
    if (error instanceof CasLimitError && FACTOR_BUDGETS.has(error.budget)) return squareFreeParts(p, x, ctx);
    throw error;
  }
}

const FACTOR_BUDGETS: ReadonlySet<string> = new Set(['factorDegree', 'factorDigits', 'liftDigits', 'recombination']);

type Root = { readonly value: RatFun; readonly multiplicity: number; readonly real: boolean; readonly order: number };

/**
 * Closed-form roots of a `polynomialIn` result: rational and quadratic-surd
 * roots over ℚ, and roots in ℚ(π, e) and its square roots for π/e
 * coefficients (`pi*x = 1` → `1/pi`). A quadratic whose discriminant's sign
 * the `digits` budget cannot decide goes to `numeric`. Zero-testing assumes π
 * and e are algebraically independent (standard, unproven; see the README).
 */
export function exactRoots(form: PolynomialForm, options: CasOptions = {}): ExactRoots {
  if (form.coefficients.length === 0) throw new InvalidArgumentError('the zero polynomial has every number as a root');
  const ctx = new Context(options);
  const values = form.coefficients.map(c =>
    c.rational === null ? read(inputExpr(c.value, ctx).root, ctx) : ctx.fromPoly(constant(c.rational)),
  );
  for (const v of values) {
    if (!ctx.isConstant(v.num) || !ctx.isConstant(v.den)) {
      throw new InvalidArgumentError('exactRoots takes coefficients in ℚ(π, e), as polynomialIn returns them');
    }
  }
  const x = ctx.name('x', AT);
  let common = constant(ONE);
  for (const v of values)
    common = multiply(common, exactQuotient(v.den, gcd(common, v.den, ctx.budget), ctx), ctx.budget);
  const scaled = values.map(v => multiply(v.num, exactQuotient(common, v.den, ctx), ctx.budget));
  const zeros = scaled.findIndex(c => !isZero(c));
  const p = fromCoefficientsIn(scaled.slice(zeros), x);

  const roots: Root[] = [];
  const numeric: { coefficients: number[]; multiplicity: number }[] = [];
  if (zeros > 0) roots.push({ value: ctx.fromPoly(EMPTY), multiplicity: zeros, real: true, order: 0 });
  const parts = degreeIn(p, x) <= 2 ? [[p, 1] as const] : rootParts(p, x, ctx);
  for (const [part, multiplicity] of parts) {
    const cs = coefficientsIn(part, x);
    if (cs.length === 2) {
      const [c0 = EMPTY, c1 = EMPTY] = cs;
      roots.push({
        value: ctx.quotient(negate(c0), c1),
        multiplicity,
        real: true,
        order: -constantFloat(c0, ctx) / constantFloat(c1, ctx),
      });
    } else if (cs.length === 3) {
      const [c = EMPTY, b = EMPTY, a = EMPTY] = cs;
      const discriminant = subtract(
        multiply(b, b, ctx.budget),
        scale(multiply(a, c, ctx.budget), Rational.fromParts(4n, 1n)),
      );
      const twoA = ctx.fromPoly(scale(a, Rational.fromParts(2n, 1n)));
      const minusB = ctx.fromPoly(negate(b));
      const [af, bf] = [constantFloat(a, ctx), constantFloat(b, ctx)];
      const sign = constantSign(discriminant, ctx);
      if (sign === 0) {
        roots.push({
          value: ctx.divide(minusB, twoA),
          multiplicity: 2 * multiplicity,
          real: true,
          order: -bf / (2 * af),
        });
      } else if (sign === undefined) {
        numeric.push({ coefficients: cs.map(c => constantFloat(c, ctx)), multiplicity });
      } else {
        const magnitude = sign > 0 ? discriminant : negate(discriminant);
        const root = sqrtOf(magnitude, ctx);
        const s = sign > 0 ? root : ctx.multiply(root, ctx.generatorValue(ctx.atom('i', AT)));
        const offset = Math.sqrt(Math.abs(constantFloat(discriminant, ctx))) / (2 * af);
        for (const [shift, sign2] of [
          [ctx.negate(s), -1],
          [s, 1],
        ] as const) {
          const order = sign > 0 ? -bf / (2 * af) + sign2 * offset : sign2;
          roots.push({ value: ctx.divide(ctx.add(minusB, shift), twoA), multiplicity, real: sign > 0, order });
        }
      }
    } else if (cs.length > 3) {
      numeric.push({ coefficients: cs.map(c => constantFloat(c, ctx)), multiplicity });
    }
  }
  const emitter = new Emitter(ctx);
  const sorted = roots.sort((a, b) => (a.real === b.real ? a.order - b.order : a.real ? -1 : 1));
  return {
    roots: sorted.map(r => ({
      value: exprOf(fractionNode(emitter, r.value), ctx),
      multiplicity: r.multiplicity,
      real: r.real,
    })),
    numeric,
    exact: numeric.length === 0,
  };
}

/** Always one fraction, constant denominators included: `(sqrt(5) + 1) / 2`. */
function fractionNode(emitter: Emitter, r: RatFun): Node {
  const [num, den] = emitter.fractionParts(r);
  return constantValue(den)?.eq(1) === true
    ? emitter.polyNode(num)
    : binary('/', emitter.polyNode(num), emitter.polyNode(den));
}
