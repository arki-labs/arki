/**
 * Values in ℚ[π, e] (RFC §5.3). Zero testing treats π and e as algebraically
 * independent: a value is zero exactly when all its rational coefficients are
 * zero. That is the standard CAS convention (SymPy's `QQ[pi,E]`, Mathematica's
 * `Together`, Maple's `normal`), and it is NOT a theorem: whether π and e are
 * algebraically independent is open; it is not even known whether π + e is
 * irrational. No relation between them is known.
 *
 * Signs of non-zero values are decided rigorously: π and e are enclosed in
 * rational intervals from `@arki/math` `PI`/`E` (rounded half-even at `scale`
 * digits, so off by at most half a unit in the last place), the value is
 * evaluated in exact interval arithmetic, and the precision doubles until the
 * interval excludes 0 or the `digits` budget is reached. Then the answer is
 * "unknown", never a guess.
 *
 * Internal module.
 */
import { E, PI } from '@arki/math/decimal-math';
import { Rational } from '@arki/math/rational';

import type { Context } from './context.js';
import type { Poly } from './poly.js';
import { constantValue, ONE, toFloat, ZERO } from './poly.js';

const START_SCALE = 16;

type Interval = readonly [Rational, Rational];

/** The sign of `p`, a polynomial in π and e only; `undefined` when the `digits` budget cannot decide it. */
export function constantSign(p: Poly, ctx: Context): -1 | 0 | 1 | undefined {
  const exact = constantValue(p);
  if (exact !== undefined) return exact.sign();
  let degree = 1;
  for (const term of p.values())
    degree = Math.max(
      degree,
      term.m.reduce((sum, e) => sum + e, 0),
    );
  for (let scale = START_SCALE; scale * degree <= ctx.budget.limits.digits; scale *= 2) {
    ctx.budget.spend(p.size * degree);
    const eps = Rational.fromParts(1n, 10n ** BigInt(scale));
    const pi = Rational.from(PI(scale));
    const e = Rational.from(E(scale));
    const bounds = (g: number): Interval => {
      const center = ctx.generators[g]?.kind === 'pi' ? pi : e;
      return [center.minus(eps), center.plus(eps)];
    };
    let lo = ZERO;
    let hi = ZERO;
    for (const term of p.values()) {
      // π, e > 0, so a monomial in them is monotone in each.
      let low = ONE;
      let high = ONE;
      for (const [g, exponent] of term.m.entries()) {
        if (exponent === 0) continue;
        const [l, h] = bounds(g);
        low = low.times(l.pow(exponent));
        high = high.times(h.pow(exponent));
      }
      const a = term.c.times(low);
      const b = term.c.times(high);
      lo = lo.plus(term.c.isNegative() ? b : a);
      hi = hi.plus(term.c.isNegative() ? a : b);
    }
    if (lo.isPositive()) return 1;
    if (hi.isNegative()) return -1;
  }
  return undefined;
}

/** `p` in floating point, π and e as `Math.PI` and `Math.E`. */
export function constantFloat(p: Poly, ctx: Context): number {
  return toFloat(p, g => (ctx.generators[g]?.kind === 'pi' ? Math.PI : Math.E));
}
