/**
 * Per-call state (RFC §5.2): the generator table, the rational-function
 * normal form `RatFun`, and the divisors every result's conditions come from.
 * A context is built for one verb call and dropped afterwards; nothing is
 * cached across calls.
 *
 * Internal module.
 */
import type { Language, Span } from '@arki/expr';
import { scientific } from '@arki/expr';
import { DivisionByZeroError } from '@arki/math/errors';

import type { CasOptions } from './core.js';
import type { Poly } from './poly.js';
import { Budget } from './core.js';
import {
  add,
  constant,
  constantValue,
  divideExact,
  gcd,
  generator,
  generators,
  isZero,
  leadingTerm,
  multiply,
  negate,
  ONE,
  power,
  rationalContent,
  scale,
  squareFreePart,
} from './poly.js';

/**
 * A generator of the polynomial ring. Kernels are everything that is not
 * `+ - * / ^integer` over names, π, e and rationals (`sin(u)`, `exp(u)`,
 * `u^(1/2)`); they are keyed by the canonical print of their arguments, so
 * equal kernels are one generator. An atom is a constant printed as a bare
 * name (a host language's constant, or `i` in complex roots).
 */
export type Generator =
  | { readonly kind: 'name'; readonly name: string; readonly span: Span }
  | { readonly kind: 'pi' }
  | { readonly kind: 'e' }
  | { readonly kind: 'atom'; readonly name: string; readonly span: Span }
  | {
      readonly kind: 'kernel';
      /** A function name, or `'^'` for a power `args[0]^args[1]` that is not a polynomial power. */
      readonly fn: string;
      readonly args: readonly RatFun[];
      readonly key: string;
      readonly span: Span;
      /** Free variable names inside the arguments. */
      readonly names: ReadonlySet<string>;
    };

/** num/den with gcd(num, den) = 1 and den normalized: coprime integer coefficients, positive leading coefficient. */
export type RatFun = { readonly num: Poly; readonly den: Poly };

const UNIT: Poly = constant(ONE);

export class Context {
  readonly budget: Budget;
  readonly language: Language;
  readonly numbers: 'fraction' | 'decimal';
  readonly generators: Generator[] = [];
  /** Every polynomial the input divides by: each must be non-zero where the input is defined. */
  readonly divisors: Poly[] = [];
  private readonly ids = new Map<string, number>();

  constructor(options: CasOptions) {
    this.budget = new Budget(options);
    this.language = options.language ?? scientific;
    this.numbers = options.numbers ?? 'fraction';
  }

  private intern(key: string, make: () => Generator): number {
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    const id = this.generators.length;
    this.generators.push(make());
    this.ids.set(key, id);
    return id;
  }

  pi(): number {
    return this.intern('pi', () => ({ kind: 'pi' }));
  }

  e(): number {
    return this.intern('e', () => ({ kind: 'e' }));
  }

  name(name: string, span: Span): number {
    return this.intern(`name:${name}`, () => ({ kind: 'name', name, span }));
  }

  atom(name: string, span: Span): number {
    return this.intern(`atom:${name}`, () => ({ kind: 'atom', name, span }));
  }

  /** The id of a name if the input used it. */
  nameId(name: string): number | undefined {
    return this.ids.get(`name:${name}`);
  }

  kernel(fn: string, args: readonly RatFun[], key: string, span: Span): number {
    return this.intern(`kernel:${key}`, () => {
      const names = new Set<string>();
      for (const arg of args) for (const n of this.namesIn(arg)) names.add(n);
      return { kind: 'kernel', fn, args, key, span, names };
    });
  }

  /** Free variable names of a value, through kernel arguments. */
  namesIn(r: RatFun): Set<string> {
    const out = new Set<string>();
    for (const g of [...generators(r.num), ...generators(r.den)]) {
      const gen = this.generators[g];
      if (gen?.kind === 'name') out.add(gen.name);
      else if (gen?.kind === 'kernel') for (const n of gen.names) out.add(n);
    }
    return out;
  }

  /** True when every generator of `p` is π or e. */
  isConstant(p: Poly): boolean {
    for (const g of generators(p)) {
      const kind = this.generators[g]?.kind;
      if (kind !== 'pi' && kind !== 'e') return false;
    }
    return true;
  }

  // ---- RatFun arithmetic ----

  fromPoly(p: Poly): RatFun {
    return { num: p, den: UNIT };
  }

  /** num/den in normal form: cancelled by the gcd, denominator normalized. */
  quotient(num: Poly, den: Poly): RatFun {
    if (isZero(den)) throw new DivisionByZeroError('cas: division by zero');
    if (isZero(num)) return { num, den: UNIT };
    let n = num;
    let d = den;
    if (constantValue(d) === undefined) {
      const g = gcd(n, d, this.budget);
      if (constantValue(g) === undefined) {
        n = divideExact(n, g, this.budget) ?? n;
        d = divideExact(d, g, this.budget) ?? d;
      }
    }
    const dc = constantValue(d);
    if (dc !== undefined) return { num: scale(n, dc.inverse()), den: UNIT };
    const content = rationalContent(d);
    const unit = leadingTerm(d)?.c.isNegative() === true ? content.negated() : content;
    return { num: scale(n, unit.inverse()), den: scale(d, unit.inverse()) };
  }

  add(a: RatFun, b: RatFun): RatFun {
    if (constantValue(a.den) !== undefined && constantValue(b.den) !== undefined) return this.fromPoly(add(a.num, b.num));
    return this.quotient(
      add(multiply(a.num, b.den, this.budget), multiply(b.num, a.den, this.budget)),
      multiply(a.den, b.den, this.budget),
    );
  }

  negate(a: RatFun): RatFun {
    return { num: negate(a.num), den: a.den };
  }

  multiply(a: RatFun, b: RatFun): RatFun {
    const num = multiply(a.num, b.num, this.budget);
    if (constantValue(a.den) !== undefined && constantValue(b.den) !== undefined) return this.fromPoly(num);
    return this.quotient(num, multiply(a.den, b.den, this.budget));
  }

  divide(a: RatFun, b: RatFun): RatFun {
    if (isZero(b.num)) throw new DivisionByZeroError('cas: division by zero');
    this.divisors.push(b.num);
    return this.quotient(multiply(a.num, b.den, this.budget), multiply(a.den, b.num, this.budget));
  }

  power(a: RatFun, n: number): RatFun {
    if (n >= 0) return { num: power(a.num, n, this.budget), den: power(a.den, n, this.budget) };
    if (isZero(a.num)) throw new DivisionByZeroError('cas: zero to a negative power');
    this.divisors.push(a.num);
    return this.quotient(power(a.den, -n, this.budget), power(a.num, -n, this.budget));
  }

  // ---- conditions ----

  /**
   * The divisors the result no longer shows (RFC §6 "pruning"): for each,
   * the factors not shared with `visible` (the result's denominators,
   * kernel arguments included), square-free and normalized. Constants of
   * ℚ[π, e] are non-zero by the zero test and never become conditions.
   */
  lostDivisors(visible: readonly Poly[]): Poly[] {
    const out: Poly[] = [];
    for (const divisor of this.divisors) {
      let q = divisor;
      for (const v of visible) {
        for (let g = gcd(q, v, this.budget); constantValue(g) === undefined; g = gcd(q, v, this.budget)) {
          q = divideExact(q, g, this.budget) ?? q;
        }
      }
      if (this.isConstant(q)) continue;
      out.push(squareFreePart(q, this.budget));
    }
    return out;
  }

  /** The denominators a value shows: its own and those inside its kernels, recursively. */
  visibleDenominators(r: RatFun): Poly[] {
    const out: Poly[] = [r.den];
    const seen = new Set<number>();
    const stack = [...generators(r.num), ...generators(r.den)];
    for (let g = stack.pop(); g !== undefined; g = stack.pop()) {
      if (seen.has(g)) continue;
      seen.add(g);
      const gen = this.generators[g];
      if (gen?.kind !== 'kernel') continue;
      for (const arg of gen.args) {
        out.push(arg.den);
        stack.push(...generators(arg.num), ...generators(arg.den));
      }
    }
    return out;
  }

  /** The generator `g` as a value. */
  generatorValue(g: number): RatFun {
    return this.fromPoly(generator(g));
  }
}
