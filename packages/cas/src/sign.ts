/**
 * The sign oracle (RFC §6): small, sound and incomplete. It answers with the
 * set of signs a value can take where it is defined, so "unknown" is the full
 * set and never licenses a rewrite.
 *
 * | Value | Signs |
 * | --- | --- |
 * | a name | its assumption, else unknown |
 * | π, e | positive |
 * | a constant of ℚ[π, e] | rigorous, from `constantSign` (unknown past the `digits` budget) |
 * | `exp(u)`, `cosh(u)`, `u!` | positive |
 * | `abs(u)`, `sqrt(u)`, even roots, `u^(p/q)` | ≥ 0; > 0 when `u ≠ 0` (`u > 0` for roots) |
 * | `u^(p/q)` with p/q < 0 | positive |
 * | `sign`, `cbrt`, odd roots, `atan`, `asin`, `sinh`, `tanh`, `asinh`, `atanh` | the signs of `u` |
 * | `ln(u)`, `log(u)` | the signs of `u - 1` |
 * | `u^(2k)`, and any polynomial that is a perfect square (`x^2 - 2*x + 1`) | ≥ 0; > 0 when `u ≠ 0` |
 * | sums, products, quotients | by sign rules: non-negatives with one positive term are positive (`x^2 + 1`) |
 *
 * Each answer also names the variables whose assumptions it used, so a
 * rewrite can return them as `assumed` conditions.
 *
 * Internal module.
 */
import type { Context, RatFun } from './context.js';
import type { Assumption } from './core.js';
import type { Monomial, Poly } from './poly.js';
import { constantSign } from './constants.js';
import { rationalValue } from './context.js';
import { add, EMPTY, fromTerm, polySqrt, subtract } from './poly.js';

/** A set of signs, as bits. */
export type Signs = number;
export const NEGATIVE = 1;
export const ZERO = 2;
export const POSITIVE = 4;
export const UNKNOWN = 7;

export type Fact = { readonly signs: Signs; readonly names: ReadonlySet<string> };

/** The relations a rewrite may ask the oracle to prove. */
export type Claim = 'positive' | 'nonnegative' | 'nonzero' | 'nonpositive' | 'negative';

const NONE: ReadonlySet<string> = new Set();

const ASSUMED: Readonly<Record<Assumption, Signs>> = {
  positive: POSITIVE,
  nonnegative: ZERO | POSITIVE,
  negative: NEGATIVE,
  nonzero: NEGATIVE | POSITIVE,
};

/** Odd functions that are increasing where defined: their sign is the sign of the argument. */
const SAME_SIGN: ReadonlySet<string> = new Set(['sign', 'cbrt', 'atan', 'asin', 'sinh', 'tanh', 'asinh', 'atanh']);
const POSITIVE_FUNCTIONS: ReadonlySet<string> = new Set(['exp', 'cosh', '!']);

/** True when every sign in `signs` satisfies `claim`. An empty set proves nothing. */
export function holds(signs: Signs, claim: Claim): boolean {
  if (signs === 0) return false;
  const allowed = {
    positive: POSITIVE,
    nonnegative: ZERO | POSITIVE,
    nonzero: NEGATIVE | POSITIVE,
    nonpositive: NEGATIVE | ZERO,
    negative: NEGATIVE,
  }[claim];
  return (signs & ~allowed) === 0;
}

function signOf(s: -1 | 0 | 1): Signs {
  return s < 0 ? NEGATIVE : s > 0 ? POSITIVE : ZERO;
}

function times(a: Signs, b: Signs): Signs {
  let out = 0;
  for (const x of [NEGATIVE, ZERO, POSITIVE]) {
    if ((a & x) === 0) continue;
    for (const y of [NEGATIVE, ZERO, POSITIVE]) {
      if ((b & y) === 0) continue;
      out |= x === ZERO || y === ZERO ? ZERO : x === y ? POSITIVE : NEGATIVE;
    }
  }
  return out;
}

function plus(a: Signs, b: Signs): Signs {
  if (a === ZERO) return b;
  if (b === ZERO) return a;
  const negative = ((a | b) & NEGATIVE) !== 0;
  const positive = ((a | b) & POSITIVE) !== 0;
  if (negative && positive) return UNKNOWN;
  return (negative ? NEGATIVE : POSITIVE) | (a & b & ZERO);
}

function toPower(s: Signs, n: number): Signs {
  if (n % 2 === 1) return s;
  return ((s & (NEGATIVE | POSITIVE)) === 0 ? 0 : POSITIVE) | (s & ZERO);
}

function union(a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> {
  if (a.size === 0) return b;
  if (b.size === 0) return a;
  return new Set([...a, ...b]);
}

export class SignOracle {
  private readonly ctx: Context;
  private readonly assumptions: ReadonlyMap<string, Assumption>;
  private readonly memo = new Map<number, Fact>();

  /** `assumptions` empty: proofs from the expression alone. */
  constructor(ctx: Context, assumptions: ReadonlyMap<string, Assumption>) {
    this.ctx = ctx;
    this.assumptions = assumptions;
  }

  /** The signs of a value where it is defined: its denominator is non-zero there. */
  value(r: RatFun): Fact {
    const num = this.poly(r.num);
    const den = this.poly(r.den);
    const nonzero = den.signs & ~ZERO;
    return { signs: nonzero === 0 ? UNKNOWN : times(num.signs, nonzero), names: union(num.names, den.names) };
  }

  /** Terms are grouped by their part outside π and e, so `(pi - 3)*x^2` is decided by the sign of `pi - 3`. */
  poly(p: Poly): Fact {
    if (p.size === 0) return { signs: ZERO, names: NONE };
    this.ctx.budget.spend(p.size);
    const groups = new Map<string, { m: Monomial; c: Poly }>();
    for (const term of p.values()) {
      const rest: number[] = [];
      const constantPart: number[] = [];
      for (const [g, e] of term.m.entries()) {
        const kind = this.ctx.generators[g]?.kind;
        const isConstant = kind === 'pi' || kind === 'e';
        rest.push(isConstant ? 0 : e);
        constantPart.push(isConstant ? e : 0);
      }
      while (rest.length > 0 && rest.at(-1) === 0) rest.pop();
      const key = rest.join(',');
      const group = groups.get(key) ?? { m: rest, c: EMPTY };
      groups.set(key, { m: group.m, c: add(group.c, fromTerm(constantPart, term.c)) });
    }
    let signs: Signs = ZERO;
    let names = NONE;
    for (const { m, c } of groups.values()) {
      const s = constantSign(c, this.ctx);
      let term: Signs = s === undefined ? UNKNOWN : signOf(s);
      for (const [g, e] of m.entries()) {
        if (e === 0) continue;
        const fact = this.generator(g);
        term = times(term, toPower(fact.signs, e));
        names = union(names, fact.names);
      }
      signs = plus(signs, term);
      if (signs === UNKNOWN) break;
    }
    if (signs !== UNKNOWN) return { signs, names };
    // An expanded square, `x^2 - 2*x + 1`, is ≥ 0.
    return { signs: polySqrt(p, this.ctx.budget) === undefined ? UNKNOWN : ZERO | POSITIVE, names: NONE };
  }

  generator(g: number): Fact {
    const known = this.memo.get(g);
    if (known !== undefined) return known;
    const fact = this.compute(g);
    this.memo.set(g, fact);
    return fact;
  }

  private compute(g: number): Fact {
    const gen = this.ctx.generators[g];
    switch (gen?.kind) {
      case 'pi':
      case 'e': {
        return { signs: POSITIVE, names: NONE };
      }
      case 'name': {
        const assumption = this.assumptions.get(gen.name);
        return assumption === undefined
          ? { signs: UNKNOWN, names: NONE }
          : { signs: ASSUMED[assumption], names: new Set([gen.name]) };
      }
      case 'atom':
      case undefined: {
        return { signs: UNKNOWN, names: NONE };
      }
      case 'kernel': {
        return this.kernel(gen.fn, gen.args);
      }
    }
  }

  private kernel(fn: string, args: readonly RatFun[]): Fact {
    const [u, v] = args;
    if (u === undefined) return { signs: UNKNOWN, names: NONE };
    if (POSITIVE_FUNCTIONS.has(fn) && args.length === 1) return { signs: POSITIVE, names: NONE };
    if (SAME_SIGN.has(fn) && args.length === 1) return this.value(u);
    const n = v === undefined ? undefined : rationalValue(v);
    if (fn === 'nthRoot' && n?.isInteger() === true && n.numerator % 2n === 1n) return this.value(u);
    if (fn === 'abs') return this.atLeastZero(u, 'nonzero');
    if (fn === 'sqrt' || fn === 'nthRoot') return this.atLeastZero(u, 'positive');
    if (fn === '^' && n !== undefined)
      return n.isNegative() ? { signs: POSITIVE, names: NONE } : this.atLeastZero(u, 'positive');
    // ln(u), log10(u) and log2(u) have the sign of u - 1 = (num - den)/den.
    if ((fn === 'ln' || fn === 'log' || fn === 'log10' || fn === 'log2') && args.length === 1)
      return this.value({ num: subtract(u.num, u.den), den: u.den });
    return { signs: UNKNOWN, names: NONE };
  }

  /** ≥ 0, and > 0 when `u` satisfies `claim`. */
  private atLeastZero(u: RatFun, claim: Claim): Fact {
    const fact = this.value(u);
    return holds(fact.signs, claim) ? { signs: POSITIVE, names: fact.names } : { signs: ZERO | POSITIVE, names: NONE };
  }
}
