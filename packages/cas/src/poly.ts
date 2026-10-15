/**
 * Sparse multivariate polynomials over ℚ (RFC §5.2). Generators are small
 * integer ids handed out per call (names, π, e, kernels); a monomial is the
 * exponent of each id, trailing zeros trimmed, so equal monomials have equal
 * keys. Values are immutable: every operation returns a new map.
 *
 * Internal module.
 */
import { DivisionByZeroError } from '@arki/math/errors';
import { Rational } from '@arki/math/rational';

import type { Budget } from './core.js';

export type Monomial = readonly number[];
export type Term = { readonly m: Monomial; readonly c: Rational };
/** Monomial key → term. Never holds a zero coefficient; the zero polynomial is the empty map. */
export type Poly = ReadonlyMap<string, Term>;

export const ZERO = Rational.fromParts(0n, 1n);
export const ONE = Rational.fromParts(1n, 1n);
/** The zero polynomial. */
export const EMPTY: Poly = new Map();

function keyOf(m: Monomial): string {
  return m.join(',');
}

function trimmed(m: number[]): Monomial {
  let end = m.length;
  while (end > 0 && m[end - 1] === 0) end--;
  return end === m.length ? m : m.slice(0, end);
}

function put(target: Map<string, Term>, m: Monomial, c: Rational): void {
  const key = keyOf(m);
  const existing = target.get(key);
  const sum = existing === undefined ? c : existing.c.plus(c);
  if (sum.isZero()) target.delete(key);
  else target.set(key, { m, c: sum });
}

export function constant(c: Rational): Poly {
  return c.isZero() ? EMPTY : new Map([['', { m: [], c }]]);
}

/** `g^exponent` for generator id `g`. */
export function generator(g: number, exponent = 1): Poly {
  const m = Array.from({ length: g + 1 }, (_, i) => (i === g ? exponent : 0));
  return new Map([[keyOf(m), { m, c: ONE }]]);
}

export function isZero(p: Poly): boolean {
  return p.size === 0;
}

/** The value of a polynomial without generators, else `undefined`. */
export function constantValue(p: Poly): Rational | undefined {
  if (p.size === 0) return ZERO;
  if (p.size !== 1) return undefined;
  const term = p.get('');
  return term === undefined ? undefined : term.c;
}

export function add(a: Poly, b: Poly): Poly {
  if (a.size === 0) return b;
  if (b.size === 0) return a;
  const out = new Map(a);
  for (const term of b.values()) put(out, term.m, term.c);
  return out;
}

export function negate(p: Poly): Poly {
  const out = new Map<string, Term>();
  for (const [key, term] of p) out.set(key, { m: term.m, c: term.c.negated() });
  return out;
}

export function subtract(a: Poly, b: Poly): Poly {
  return add(a, negate(b));
}

export function scale(p: Poly, c: Rational): Poly {
  if (c.isZero()) return EMPTY;
  if (c.eq(ONE)) return p;
  const out = new Map<string, Term>();
  for (const [key, term] of p) out.set(key, { m: term.m, c: term.c.times(c) });
  return out;
}

function digitsOf(c: Rational): number {
  const n = c.numerator < 0n ? -c.numerator : c.numerator;
  return n.toString().length + c.denominator.toString().length;
}

/** The most digits in any coefficient (numerator plus denominator). */
export function maxDigits(p: Poly): number {
  let most = 0;
  for (const term of p.values()) most = Math.max(most, digitsOf(term.c));
  return most;
}

/** The highest exponent of any generator. */
export function maxDegree(p: Poly): number {
  let most = 0;
  for (const term of p.values()) for (const e of term.m) most = Math.max(most, e);
  return most;
}

/** The highest exponent of each generator id. */
function degrees(p: Poly): number[] {
  const out: number[] = [];
  for (const term of p.values()) for (const [g, e] of term.m.entries()) (out[g] = Math.max(out[g] ?? 0, e));
  return out;
}

/** The degree in one generator of a product, at most. */
function productDegree(a: Poly, b: Poly): number {
  const da = degrees(a);
  const db = degrees(b);
  let most = 0;
  for (let g = 0; g < Math.max(da.length, db.length); g++) most = Math.max(most, (da[g] ?? 0) + (db[g] ?? 0));
  return most;
}

function multiplyMonomials(a: Monomial, b: Monomial): Monomial {
  const length = Math.max(a.length, b.length);
  const m = Array.from({ length }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0));
  return trimmed(m);
}

/** Checks the product's degree, digits and size before multiplying. */
export function multiply(a: Poly, b: Poly, budget: Budget): Poly {
  if (a.size === 0 || b.size === 0) return EMPTY;
  budget.check('degree', productDegree(a, b));
  budget.check('digits', maxDigits(a) + maxDigits(b));
  budget.check('terms', a.size * b.size);
  budget.spend(a.size * b.size);
  const out = new Map<string, Term>();
  for (const x of a.values()) for (const y of b.values()) put(out, multiplyMonomials(x.m, y.m), x.c.times(y.c));
  return out;
}

/** log10 of C(n + k - 1, k - 1): the number of terms of a k-term sum to the n-th power. */
function log10Multinomial(n: number, k: number): number {
  let sum = 0;
  for (let i = 1; i < k; i++) sum += Math.log10(n + i) - Math.log10(i);
  return sum;
}

/** `p^n` for an integer n ≥ 0. Every budget is checked from the exponent before any arithmetic. */
export function power(p: Poly, n: number, budget: Budget): Poly {
  if (n === 0) return constant(ONE);
  if (n === 1 || p.size === 0) return p;
  budget.check('degree', n * maxDegree(p));
  budget.check('digits', n * maxDigits(p));
  if (p.size === 1) {
    const [term] = p.values();
    if (term === undefined) return EMPTY;
    return new Map([[keyOf(term.m.map(e => e * n)), { m: term.m.map(e => e * n), c: term.c.pow(n) }]]);
  }
  // Bounded by `terms` (at most 10 000) and `degree`, so the estimate stays far below overflow.
  const terms = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(10 ** log10Multinomial(n, p.size)));
  budget.check('terms', terms);
  let result = p;
  for (let i = 1; i < n; i++) result = multiply(result, p, budget);
  return result;
}

/** Ids of the generators `p` uses. */
export function generators(p: Poly): Set<number> {
  const out = new Set<number>();
  for (const term of p.values()) {
    for (const [g, e] of term.m.entries()) if (e > 0) out.add(g);
  }
  return out;
}

export function degreeIn(p: Poly, g: number): number {
  let most = -1;
  for (const term of p.values()) most = Math.max(most, term.m[g] ?? 0);
  return most;
}

/** Coefficients of `p` as a polynomial in `g`, ascending; each is free of `g`. `[]` for zero. */
export function coefficientsIn(p: Poly, g: number): Poly[] {
  const out: Map<string, Term>[] = Array.from({ length: degreeIn(p, g) + 1 }, () => new Map<string, Term>());
  for (const term of p.values()) {
    const e = term.m[g] ?? 0;
    const m = trimmed(term.m.map((x, i) => (i === g ? 0 : x)));
    out[e]?.set(keyOf(m), { m, c: term.c });
  }
  return out;
}

/** Σ cᵢ·gⁱ from ascending coefficients free of `g`. */
export function fromCoefficientsIn(coefficients: readonly Poly[], g: number): Poly {
  const out = new Map<string, Term>();
  for (const [i, c] of coefficients.entries()) {
    for (const term of c.values()) {
      const m = Array.from({ length: Math.max(term.m.length, g + 1) }, (_, j) => (j === g ? i : (term.m[j] ?? 0)));
      put(out, trimmed(m), term.c);
    }
  }
  return out;
}

/** Lexicographic order with the highest generator id most significant. */
export function compareMonomials(a: Monomial, b: Monomial): number {
  for (let i = Math.max(a.length, b.length) - 1; i >= 0; i--) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The term with the greatest monomial in `compareMonomials` order. */
export function leadingTerm(p: Poly): Term | undefined {
  let lead: Term | undefined;
  for (const term of p.values()) if (lead === undefined || compareMonomials(term.m, lead.m) > 0) lead = term;
  return lead;
}

function gcdBig(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** The positive rational c with p/c having coprime integer coefficients. */
export function rationalContent(p: Poly): Rational {
  let numerators = 0n;
  let denominators = 1n;
  for (const term of p.values()) {
    numerators = gcdBig(numerators, term.c.numerator);
    denominators = (denominators / gcdBig(denominators, term.c.denominator)) * term.c.denominator;
  }
  return numerators === 0n ? ONE : Rational.fromParts(numerators, denominators);
}

/** `p` scaled to coprime integer coefficients with a positive leading coefficient. */
export function normalized(p: Poly): Poly {
  const lead = leadingTerm(p);
  if (lead === undefined) return p;
  const c = rationalContent(p);
  return scale(p, lead.c.isNegative() ? c.inverse().negated() : c.inverse());
}

/** `a / b` when `b` divides `a` exactly, else `undefined`. Recursion depth is the number of generators of `b`. */
export function divideExact(a: Poly, b: Poly, budget: Budget): Poly | undefined {
  const bc = constantValue(b);
  if (bc !== undefined) {
    if (bc.isZero()) throw new DivisionByZeroError('cas: division by the zero polynomial');
    return scale(a, bc.inverse());
  }
  if (a.size === 0) return a;
  const v = Math.max(...generators(b));
  const db = degreeIn(b, v);
  const lb = coefficientsIn(b, v)[db] ?? EMPTY;
  let r = a;
  let q: Poly = EMPTY;
  while (r.size > 0) {
    const dr = degreeIn(r, v);
    if (dr < db) return undefined;
    const t = divideExact(coefficientsIn(r, v)[dr] ?? EMPTY, lb, budget);
    if (t === undefined) return undefined;
    const qt = multiply(t, generator(v, dr - db), budget);
    q = add(q, qt);
    r = subtract(r, multiply(qt, b, budget));
  }
  return q;
}

/** ∂p/∂g. */
export function derivativeIn(p: Poly, g: number): Poly {
  const out = new Map<string, Term>();
  for (const term of p.values()) {
    const e = term.m[g] ?? 0;
    if (e === 0) continue;
    const m = trimmed(term.m.map((x, i) => (i === g ? x - 1 : x)));
    put(out, m, term.c.times(e));
  }
  return out;
}

/** gcd of the coefficients of `p` in `g` (a polynomial free of `g`). */
function contentIn(p: Poly, g: number, budget: Budget): Poly {
  let c: Poly = EMPTY;
  for (const coefficient of coefficientsIn(p, g)) {
    if (coefficient.size === 0) continue;
    c = c.size === 0 ? normalized(coefficient) : gcdRecursive(c, coefficient, budget);
    if (constantValue(c) !== undefined) return constant(ONE);
  }
  return c;
}

/** The pseudo-remainder of `a` by `b` in `g`: lc(b)^k·a mod b. */
function pseudoRemainder(a: Poly, b: Poly, g: number, budget: Budget): Poly {
  const db = degreeIn(b, g);
  const lb = coefficientsIn(b, g)[db] ?? EMPTY;
  let r = a;
  for (let dr = degreeIn(r, g); r.size > 0 && dr >= db; dr = degreeIn(r, g)) {
    const lr = coefficientsIn(r, g)[dr] ?? EMPTY;
    r = subtract(multiply(lb, r, budget), multiply(multiply(lr, generator(g, dr - db), budget), b, budget));
  }
  return r;
}

/** `p` divided by its content in `g` (the gcd of its coefficients), normalized. */
export function primitiveIn(p: Poly, g: number, budget: Budget): Poly {
  const c = contentIn(p, g, budget);
  const q = constantValue(c) === undefined ? divideExact(p, c, budget) : p;
  return normalized(q ?? p);
}

function gcdRecursive(a: Poly, b: Poly, budget: Budget): Poly {
  if (a.size === 0) return normalized(b);
  if (b.size === 0) return normalized(a);
  const gens = new Set([...generators(a), ...generators(b)]);
  if (gens.size === 0) return constant(ONE);
  const v = Math.max(...gens);
  const da = degreeIn(a, v);
  const db = degreeIn(b, v);
  if (da === 0) return gcdRecursive(a, contentIn(b, v, budget), budget);
  if (db === 0) return gcdRecursive(contentIn(a, v, budget), b, budget);
  const content = gcdRecursive(contentIn(a, v, budget), contentIn(b, v, budget), budget);
  let r0 = primitiveIn(a, v, budget);
  let r1 = primitiveIn(b, v, budget);
  if (da < db) [r0, r1] = [r1, r0];
  // Primitive PRS: every remainder is reduced to its primitive part, so coefficients stay small.
  while (r1.size > 0 && degreeIn(r1, v) > 0) {
    const r = pseudoRemainder(r0, r1, v, budget);
    r0 = r1;
    r1 = r.size === 0 ? r : primitiveIn(r, v, budget);
  }
  const g = r1.size === 0 ? r0 : constant(ONE);
  return normalized(multiply(content, g, budget));
}

/**
 * The gcd of two polynomials over ℚ, normalized (coprime integer
 * coefficients, positive leading coefficient); 1 when they are coprime.
 * Generators are variables, π and e included (RFC §8.1).
 */
export function gcd(a: Poly, b: Poly, budget: Budget): Poly {
  budget.check('gcdDegree', Math.max(maxDegree(a), maxDegree(b)));
  budget.check('depth', new Set([...generators(a), ...generators(b)]).size);
  return gcdRecursive(a, b, budget);
}

/** The product of the distinct irreducible factors of `p`, up to a constant. */
export function squareFreePart(p: Poly, budget: Budget): Poly {
  let q = p;
  for (const g of generators(p)) {
    const d = gcd(q, derivativeIn(q, g), budget);
    q = constantValue(d) === undefined ? (divideExact(q, d, budget) ?? q) : q;
  }
  return normalized(q);
}

/** Evaluates `p` in floating point, with `value(g)` for each generator. */
export function toFloat(p: Poly, value: (g: number) => number): number {
  let sum = 0;
  for (const term of p.values()) {
    let product = term.c.toNumber();
    for (const [g, e] of term.m.entries()) {
      if (e > 0) product *= value(g) ** e;
    }
    sum += product;
  }
  return sum;
}
