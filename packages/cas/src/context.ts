/**
 * Per-call state (RFC §5.2): the generator table, the rational-function
 * normal form `RatFun`, and the divisors every result's conditions come from.
 * A context is built for one verb call and dropped afterwards; nothing is
 * cached across calls.
 *
 * Internal module.
 */
import type { Language, Node, Span } from '@arki/expr';
import { parse, scientific } from '@arki/expr';
import { DivisionByZeroError, InvalidArgumentError, MathError } from '@arki/math/errors';

import type { Assumption, CasOptions } from './core.js';
import type { Poly } from './poly.js';
import { Budget, CasError } from './core.js';
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

const ASSUMPTIONS: ReadonlySet<string> = new Set(['nonzero', 'positive', 'nonnegative', 'negative']);

/**
 * The normal-form phases of `simplify` (RFC §7) that the arithmetic itself
 * performs. `Context.notes` records them when a verb asks for it.
 */
export type Phase = 'fold' | 'expand' | 'collect' | 'cancel';

export class Context {
  readonly budget: Budget;
  readonly language: Language;
  readonly numbers: 'fraction' | 'decimal';
  /** The caller's sign assumptions, by variable name (a `Map`, so `__proto__` is an ordinary name). */
  readonly assumptions: ReadonlyMap<string, Assumption>;
  /** Phases the arithmetic performed, when a verb records them (`simplify`). */
  notes: Set<string> | undefined;
  /** Values of nodes already read, by identity, when a verb reads trees that share subtrees (a raw derivative). */
  cache: Map<Node, RatFun> | undefined;
  readonly generators: Generator[] = [];
  /** Every polynomial the input divides by: each must be non-zero where the input is defined. */
  readonly divisors: Poly[] = [];
  private readonly ids = new Map<string, number>();

  constructor(options: CasOptions) {
    this.budget = new Budget(options);
    this.language = options.language ?? scientific;
    this.numbers = options.numbers ?? 'fraction';
    const assumptions = new Map<string, Assumption>();
    for (const [name, assumption] of Object.entries(options.assume ?? {})) {
      // Options may come from JSON: check the value at run time, whatever the type says.
      const value: string = assumption;
      if (!ASSUMPTIONS.has(value)) {
        throw new InvalidArgumentError(
          `assume.${name} must be nonzero, positive, nonnegative or negative, got ${String(value)}`,
        );
      }
      this.checkVariable(name);
      assumptions.set(name, assumption);
    }
    this.assumptions = assumptions;
  }

  /** Throws `bad-variable` unless `variable` is a plain name that is neither a constant nor a function. */
  checkVariable(variable: string): void {
    let ok = false;
    try {
      const root = parse(variable, { language: this.language }).root;
      ok = root.kind === 'name' && root.name === variable && this.language.constantSpec(variable) === undefined;
    } catch (error) {
      if (!(error instanceof MathError)) throw error;
    }
    if (!ok || this.language.functionSpec(variable) !== undefined) {
      throw new CasError(
        `"${variable}" cannot be a variable: it is not a name, or it is a constant or function`,
        'bad-variable',
      );
    }
  }

  private note(phase: Phase): void {
    this.notes?.add(phase);
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
        this.note('cancel');
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
    if (this.notes !== undefined) this.noteSum(a, b);
    if (constantValue(a.den) !== undefined && constantValue(b.den) !== undefined)
      return this.fromPoly(add(a.num, b.num));
    return this.quotient(
      add(multiply(a.num, b.den, this.budget), multiply(b.num, a.den, this.budget)),
      multiply(a.den, b.den, this.budget),
    );
  }

  negate(a: RatFun): RatFun {
    return { num: negate(a.num), den: a.den };
  }

  multiply(a: RatFun, b: RatFun): RatFun {
    if (this.notes !== undefined) this.noteProduct(a, b);
    const num = multiply(a.num, b.num, this.budget);
    if (constantValue(a.den) !== undefined && constantValue(b.den) !== undefined) return this.fromPoly(num);
    return this.quotient(num, multiply(a.den, b.den, this.budget));
  }

  divide(a: RatFun, b: RatFun): RatFun {
    if (isZero(b.num)) throw new DivisionByZeroError('cas: division by zero');
    // `fold` when a number divides a coefficient (`6*x/2`, not `x/2`; `6/4`, not `3/2`), or for a
    // fraction as divisor: dividing by it multiplies by its reciprocal (`1/x^-1` is `x`).
    const [ra, rb] = [rationalValue(a), rationalValue(b)];
    // An integer fraction in lowest terms with a positive denominator (`3/2`) is printed as it was written.
    const written =
      ra?.isInteger() === true && rb?.isInteger() === true && ra.times(rb.inverse()).denominator === rb.numerator;
    const literal = rb !== undefined && !written && scaled(a);
    if (literal || constantValue(b.den) === undefined) this.note('fold');
    this.divisors.push(b.num);
    return this.quotient(multiply(a.num, b.den, this.budget), multiply(a.den, b.num, this.budget));
  }

  power(a: RatFun, n: number): RatFun {
    if (n === 0 || n === 1 || rationalValue(a) !== undefined) this.note('fold');
    else if (a.num.size > 1 || a.den.size > 1) this.note('expand');
    if (n >= 0) return { num: power(a.num, n, this.budget), den: power(a.den, n, this.budget) };
    if (isZero(a.num)) throw new DivisionByZeroError('cas: zero to a negative power');
    this.divisors.push(a.num);
    return this.quotient(power(a.den, -n, this.budget), power(a.num, -n, this.budget));
  }

  /** `fold` for literal arithmetic and `u + 0`; `collect` when like terms merged. */
  private noteSum(a: RatFun, b: RatFun): void {
    const ra = rationalValue(a);
    const rb = rationalValue(b);
    if ((ra !== undefined && rb !== undefined) || ra?.isZero() === true || rb?.isZero() === true) this.note('fold');
    else if (add(a.num, b.num).size < a.num.size + b.num.size) this.note('collect');
  }

  /**
   * `fold` for literal arithmetic (`3*x*2`, a number times a term that has a
   * coefficient already), `0*u` and `1*u`; `expand` when a sum is multiplied
   * out; `collect` for like powers.
   */
  private noteProduct(a: RatFun, b: RatFun): void {
    const ra = rationalValue(a);
    const rb = rationalValue(b);
    const trivial = (r: ReturnType<typeof rationalValue>): boolean => r !== undefined && (r.isZero() || r.eq(ONE));
    if (
      (ra !== undefined && rb !== undefined) ||
      trivial(ra) ||
      trivial(rb) ||
      (ra !== undefined && scaled(b)) ||
      (rb !== undefined && scaled(a))
    ) {
      this.note('fold');
      return;
    }
    if (a.num.size > 1 || b.num.size > 1) this.note('expand');
    const shared = [...generators(a.num), ...generators(a.den)].some(
      g => generators(b.num).has(g) || generators(b.den).has(g),
    );
    if (shared) this.note('collect');
  }

  /** The generator `g` as a value. */
  generatorValue(g: number): RatFun {
    return this.fromPoly(generator(g));
  }
}

/** A term of `r` has a coefficient other than 1, so a number multiplying or dividing `r` folds into it. */
function scaled(r: RatFun): boolean {
  return [...r.num.values(), ...r.den.values()].some(t => !t.c.eq(ONE));
}

/** The value of a rational constant (no generators), else `undefined`. */
export function rationalValue(r: RatFun): ReturnType<typeof constantValue> {
  return constantValue(r.den) === undefined ? undefined : constantValue(r.num);
}
