/**
 * `@arki/cas/polynomial` (RFC §8.1): polynomial and rational-function verbs.
 * Coefficients live in ℚ[π, e], with π and e treated as algebraically
 * independent (see `constants.ts`): every verb that zero-tests relies on that
 * standard, unproven assumption.
 */
import type { Expr, Node, Span } from '@arki/expr';
import type { Rational } from '@arki/math/rational';
import { InvalidArgumentError } from '@arki/math/errors';

import type { RatFun } from './context.js';
import type { CasInput, CasOptions, CasResult, Condition } from './core.js';
import type { Part } from './emit.js';
import type { Poly } from './poly.js';
import { inputDomain, lostConditions } from './conditions.js';
import { Context } from './context.js';
import { CasError } from './core.js';
import { binary, Emitter, exprOf, numberNode } from './emit.js';
import {
  coefficientsIn,
  constant,
  constantValue,
  degreeIn,
  divideExact,
  EMPTY,
  fromCoefficientsIn,
  generators,
  leadingTerm,
  multiply,
  normalized,
  ONE,
  gcd as polyGcd,
  power,
  scale,
} from './poly.js';
import { inputExpr, read } from './read.js';
import { rationalFactorization, rationalFactors, rationalIn, squareFreeParts } from './roots.js';

export { exactRoots } from './roots.js';
export type { ExactRoots } from './roots.js';

/** One coefficient: a canonical expression in ℚ(π, e), and its value when it is rational. */
export type Coefficient = { readonly value: Expr; readonly rational: Rational | null };

export type PolynomialIn =
  | {
      readonly kind: 'polynomial';
      /** Ascending; `[]` for the zero polynomial. */
      readonly coefficients: readonly Coefficient[];
      readonly conditions: readonly Condition[];
    }
  | {
      readonly kind: 'rational';
      readonly numerator: readonly Coefficient[];
      /** The roots of the denominator are excluded. */
      readonly denominator: readonly Coefficient[];
      readonly conditions: readonly Condition[];
    }
  | {
      readonly kind: 'other';
      /** `transcendental`: a kernel contains the variable; `unsupported-constant`: `sqrt(2)`, `ln(2)`…; `other-variable`: another free name. */
      readonly reason: 'transcendental' | 'unsupported-constant' | 'other-variable';
      /** The first offending node of the input. */
      readonly span: Span;
    };

export type PolynomialForm = Extract<PolynomialIn, { readonly kind: 'polynomial' }>;

function load(input: CasInput, options: CasOptions): { ctx: Context; value: RatFun } {
  const ctx = new Context(options);
  return { ctx, value: read(inputExpr(input, ctx).root, ctx) };
}

/** The conditions a value carries: every restriction of the input it no longer shows (RFC §6). */
function conditionsOf(value: RatFun, ctx: Context, main?: number): Condition[] {
  return lostConditions(ctx, inputDomain(ctx), value, new Emitter(ctx, main));
}

/** The first kernel or atom of a value, by source position. */
function firstKernel(value: RatFun, ctx: Context): Span | undefined {
  let first: Span | undefined;
  for (const g of [...generators(value.num), ...generators(value.den)]) {
    const gen = ctx.generators[g];
    if ((gen?.kind === 'kernel' || gen?.kind === 'atom') && (first === undefined || gen.span.start < first.start))
      first = gen.span;
  }
  return first;
}

/**
 * Products and integer powers of sums multiplied out; like terms collected.
 * A quotient comes back as one fraction, cancelled by the gcd (the
 * `rationalize` form). Kernels (`sin(x)`, `sqrt(x)`) stay atoms.
 */
export function expand(input: CasInput, options: CasOptions = {}): CasResult {
  const { ctx, value } = load(input, options);
  return { result: exprOf(new Emitter(ctx).node(value), ctx), conditions: conditionsOf(value, ctx) };
}

/** A polynomial grouped by powers of generator `x`: `(2*pi + 3)*x + y`. */
function collectedNode(emitter: Emitter, p: Poly, x: number): Node {
  const parts: Part[] = [];
  const coefficients = coefficientsIn(p, x);
  for (let i = coefficients.length - 1; i >= 0; i--) {
    const c = coefficients[i];
    if (c === undefined || c.size === 0) continue;
    const power =
      i === 0
        ? undefined
        : i === 1
          ? emitter.generatorNode(x)
          : binary('^', emitter.generatorNode(x), numberNode(String(i)));
    if (c.size === 1 || power === undefined) {
      parts.push(
        ...emitter.parts(
          power === undefined ? c : fromCoefficientsIn([...Array.from({ length: i }, () => EMPTY), c], x),
        ),
      );
    } else {
      parts.push({ negative: false, node: () => binary('*', emitter.polyNode(c), power) });
    }
  }
  return emitter.join(parts);
}

/** Grouped by powers of `variable`: `(2*pi + 3)*x + y`. Coefficients may hold other names, π, e and kernels. */
export function collect(input: CasInput, variable: string, options: CasOptions = {}): CasResult {
  const ctx = new Context(options);
  ctx.checkVariable(variable);
  const value = read(inputExpr(input, ctx).root, ctx);
  const x = ctx.nameId(variable);
  const emitter = new Emitter(ctx, x);
  const conditions = conditionsOf(value, ctx, x);
  if (x === undefined) return { result: exprOf(emitter.node(value), ctx), conditions };
  const [num, den] = constantValue(value.den) === undefined ? emitter.fractionParts(value) : [value.num, value.den];
  const top = collectedNode(emitter, num, x);
  const node = constantValue(den) === undefined ? binary('/', top, collectedNode(emitter, den, x)) : top;
  return { result: exprOf(node, ctx), conditions };
}

/** One fraction `numerator/denominator` with polynomial parts, cancelled by the gcd. Throws `not-rational` on a kernel. */
export function rationalize(
  input: CasInput,
  options: CasOptions = {},
): { readonly numerator: Expr; readonly denominator: Expr; readonly conditions: readonly Condition[] } {
  const { ctx, value } = load(input, options);
  const span = firstKernel(value, ctx);
  if (span !== undefined)
    throw new CasError(
      'the input is not a rational function: it holds a function call or a non-integer power',
      'not-rational',
      span,
    );
  const emitter = new Emitter(ctx);
  const [num, den] = emitter.fractionParts(value);
  return {
    numerator: exprOf(emitter.polyNode(num), ctx),
    denominator: exprOf(emitter.polyNode(den), ctx),
    conditions: conditionsOf(value, ctx),
  };
}

/**
 * The gcd of two polynomials over ℚ: monic when it has one generator,
 * otherwise with coprime integer coefficients and a positive leading
 * coefficient. Generators include names, π, e and kernels.
 */
export function gcd(a: CasInput, b: CasInput, options: CasOptions = {}): CasResult {
  const ctx = new Context(options);
  const x = read(inputExpr(a, ctx).root, ctx);
  const y = read(inputExpr(b, ctx).root, ctx);
  if (constantValue(x.den) === undefined || constantValue(y.den) === undefined) {
    throw new InvalidArgumentError('gcd takes polynomials; a quotient has no polynomial gcd');
  }
  let g = polyGcd(x.num, y.num, ctx.budget);
  const lead = leadingTerm(g);
  if (generators(g).size === 1 && lead !== undefined) g = scale(g, lead.c.inverse());
  const conditions = [...conditionsOf(x, ctx), ...conditionsOf(y, ctx)].filter(
    (c, i, all) => all.findIndex(d => d.subject.source === c.subject.source) === i,
  );
  return { result: exprOf(new Emitter(ctx).polyNode(g), ctx), conditions };
}

function coefficientOf(r: RatFun, emitter: Emitter, ctx: Context): Coefficient {
  const rational = constantValue(r.den) === undefined ? undefined : constantValue(r.num);
  return { value: exprOf(emitter.node(r), ctx), rational: rational ?? null };
}

type Offender = { readonly reason: 'transcendental' | 'unsupported-constant' | 'other-variable'; readonly span: Span };

function offenderOf(value: RatFun, variable: string, ctx: Context): Offender | undefined {
  let first: Offender | undefined;
  for (const g of new Set([...generators(value.num), ...generators(value.den)])) {
    const gen = ctx.generators[g];
    let found: Offender | undefined;
    if (gen?.kind === 'name' && gen.name !== variable) found = { reason: 'other-variable', span: gen.span };
    else if (gen?.kind === 'atom') found = { reason: 'unsupported-constant', span: gen.span };
    else if (gen?.kind === 'kernel') {
      const reason = gen.names.has(variable)
        ? 'transcendental'
        : gen.names.size > 0
          ? 'other-variable'
          : 'unsupported-constant';
      found = { reason, span: gen.span };
    }
    if (found !== undefined && (first === undefined || found.span.start < first.span.start)) first = found;
  }
  return first;
}

/**
 * The input as a polynomial in `variable` with coefficients in ℚ(π, e).
 * It answers a question, so "not a polynomial" is a result, not an error:
 * `rational` gives numerator and denominator coefficients after cancellation,
 * `other` says why and where. Conditions list the divisors the result no
 * longer shows (`x/x - 1` is `[]` with `x ≠ 0`).
 */
export function polynomialIn(input: CasInput, variable: string, options: CasOptions = {}): PolynomialIn {
  const ctx = new Context(options);
  ctx.checkVariable(variable);
  const value = read(inputExpr(input, ctx).root, ctx);
  const offender = offenderOf(value, variable, ctx);
  if (offender !== undefined) return { kind: 'other', reason: offender.reason, span: offender.span };
  const x = ctx.nameId(variable);
  const emitter = new Emitter(ctx, x);
  const conditions = conditionsOf(value, ctx, x);
  const split = (p: Poly): Poly[] => (x === undefined ? (p.size === 0 ? [] : [p]) : coefficientsIn(p, x));
  if (x !== undefined && degreeIn(value.den, x) > 0) {
    const [num, den] = emitter.fractionParts(value);
    const toCoefficients = (p: Poly): Coefficient[] => split(p).map(c => coefficientOf(ctx.fromPoly(c), emitter, ctx));
    return { kind: 'rational', numerator: toCoefficients(num), denominator: toCoefficients(den), conditions };
  }
  const coefficients = split(value.num).map(c =>
    coefficientOf(c.size === 0 ? ctx.fromPoly(c) : ctx.quotient(c, value.den), emitter, ctx),
  );
  return { kind: 'polynomial', coefficients, conditions };
}

/** `p` with its leading coefficient in `x` made positive (by that coefficient's own leading term). */
function positiveIn(p: Poly, x: number): Poly {
  const top = coefficientsIn(p, x).at(-1);
  return top !== undefined && leadingTerm(top)?.c.isNegative() === true ? scale(p, ONE.negated()) : p;
}

export type Factored = {
  /** The constant factor: a rational, or for coefficients in other names, π or e, the part without the variable. */
  readonly content: Expr;
  /** Factors in the variable, by degree then text, each with coprime integer coefficients and a positive leading coefficient. */
  readonly factors: readonly { readonly factor: Expr; readonly multiplicity: number }[];
  /**
   * True when every factor is irreducible. Each square-free part with
   * rational coefficients (after the content, which may hold other names, π
   * or e) is factored completely over ℚ. A part whose coefficients still
   * involve other names, π or e stays whole, and `complete` is false (v1 has
   * no multivariate factoring).
   */
  readonly complete: boolean;
  /** Restrictions of the input the factored form no longer shows (`x/x*(x - 1)`: x ≠ 0). */
  readonly conditions: readonly Condition[];
};

/**
 * `input` as content times a product of factors in `variable` (RFC §8.2).
 * Rational coefficients are factored completely over ℚ by Zassenhaus's
 * algorithm; every factor returned is proven irreducible, and a budget that
 * runs out (`factorDegree`, `factorDigits`, `liftDigits`, `recombination`)
 * throws `CasLimitError` instead of returning a partial answer.
 *
 * ```ts
 * factor('x^4 - 5x^2 + 4', 'x'); // content 1; x - 2, x - 1, x + 1, x + 2; complete
 * factor('2x^3 - 2x', 'x'); // content 2; x, x - 1, x + 1
 * factor('x^4 + 1', 'x'); // x^4 + 1 (irreducible over ℚ)
 * factor('y*x^2 - y', 'x'); // content y; x - 1, x + 1; complete
 * factor('x^2 - y', 'x'); // x^2 - y stays whole; complete: false
 * ```
 *
 * Throws `InvalidArgumentError` when the input is not a polynomial in the
 * variable (a quotient by it, or a function of it such as `sin(x)`).
 */
export function factor(input: CasInput, variable: string, options: CasOptions = {}): Factored {
  const ctx = new Context(options);
  ctx.checkVariable(variable);
  const value = read(inputExpr(input, ctx).root, ctx);
  const x = ctx.nameId(variable);
  const emitter = new Emitter(ctx, x);
  const conditions = conditionsOf(value, ctx, x);
  const offender = offenderOf(value, variable, ctx);
  if (offender?.reason === 'transcendental' || (x !== undefined && degreeIn(value.den, x) > 0)) {
    throw new InvalidArgumentError(`factor takes a polynomial in ${variable}`);
  }
  if (x === undefined || degreeIn(value.num, x) === 0) {
    return { content: exprOf(emitter.node(value), ctx), factors: [], complete: true, conditions };
  }
  // A square-free part with rational coefficients factors completely; one irreducible over ℚ stays
  // irreducible when transcendental constants (other names, π, e) join the coefficients.
  let complete = true;
  const found: { p: Poly; multiplicity: number }[] = [];
  if (rationalIn(value.num, x)) {
    for (const [p, multiplicity] of rationalFactorization(value.num, x, ctx)) found.push({ p, multiplicity });
  } else {
    for (const [part, multiplicity] of squareFreeParts(value.num, x, ctx)) {
      const rational = rationalIn(normalized(part), x);
      complete &&= rational;
      const pieces = rational ? rationalFactors(part, x, ctx) : [positiveIn(normalized(part), x)];
      for (const p of pieces) found.push({ p, multiplicity });
    }
  }
  let product = constant(ONE);
  for (const { p, multiplicity } of found) product = multiply(product, power(p, multiplicity, ctx.budget), ctx.budget);
  const rest = divideExact(value.num, product, ctx.budget);
  if (rest === undefined) throw new Error('cas invariant: the factors do not divide the input');
  const sorted = found
    .map(({ p, multiplicity }) => ({ factor: exprOf(emitter.polyNode(p), ctx), multiplicity, degree: degreeIn(p, x) }))
    .sort((a, b) => a.degree - b.degree || (a.factor.source < b.factor.source ? -1 : 1));
  return {
    content: exprOf(emitter.node(ctx.quotient(rest, value.den)), ctx),
    factors: sorted.map(({ factor: f, multiplicity }) => ({ factor: f, multiplicity })),
    complete,
    conditions,
  };
}
