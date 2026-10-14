/**
 * `decimal-math` against mpmath and exact integer roots
 * (fixtures/decimal-math.json, built by test/reference/gen_decimal_math.py).
 *
 * The guarantee is correct rounding: the returned digits are the true value
 * rounded once at `scale`. So every case must match exactly, in every mode —
 * including near-tie inputs, whose value sits within 10^-(scale + 45) of a
 * rounding boundary and forces the Ziv loop to retry with more guard digits.
 */
import { describe, expect, it } from 'vitest';

import type { Decimal } from './decimal.js';
import type { RoundingMode } from './rounding.js';
import fixture from '../test/reference/fixtures/decimal-math.json' with { type: 'json' };
import { cbrt, exp, ln, log, log2, log10, nthRoot, pow, sqrt } from './decimal-math.js';
import { RoundingNecessaryError } from './errors.js';

type Case = (typeof fixture.cases)[number];

const modes = fixture.modes as readonly RoundingMode[];

type Options = { scale: number; rounding: RoundingMode };

const FUNCTIONS: Record<string, (args: readonly (string | number)[], options: Options) => Decimal> = {
  sqrt: ([x], o) => sqrt(String(x), o),
  cbrt: ([x], o) => cbrt(String(x), o),
  nthRoot: ([x, n], o) => nthRoot(String(x), Number(n), o),
  exp: ([x], o) => exp(String(x), o),
  ln: ([x], o) => ln(String(x), o),
  log10: ([x], o) => log10(String(x), o),
  log2: ([x], o) => log2(String(x), o),
  log: ([x, base], o) => log(String(x), String(base), o),
  pow: ([base, exponent], o) => pow(String(base), String(exponent), o),
};

function evaluate(c: Case, rounding: RoundingMode): Decimal {
  const f = FUNCTIONS[c.fn];
  if (!f) throw new Error(`unknown function ${c.fn}`);
  return f(c.args, { scale: c.scale, rounding });
}

/** Every mismatch as `fn(args) scale mode: got … want …`, so a failure names the case. */
function mismatches(cases: readonly Case[]): string[] {
  const found: string[] = [];
  for (const c of cases) {
    const floor = BigInt(c.floor);
    for (const [index, mode] of modes.entries()) {
      const offset = c.offsets[index];
      const where = `${c.fn}(${c.args.join(', ')}) scale ${c.scale} ${mode}`;
      if (offset === 'x') {
        try {
          const got = evaluate(c, mode);
          found.push(`${where}: got ${got.toString()}, want RoundingNecessaryError`);
        } catch (error) {
          if (!(error instanceof RoundingNecessaryError)) found.push(`${where}: threw ${String(error)}`);
        }
        continue;
      }
      const want = floor + BigInt(offset ?? 'NaN');
      try {
        const got = evaluate(c, mode);
        if (got.scale !== c.scale || got.coefficient !== want) {
          found.push(`${where}: got ${got.toString()}, want coefficient ${want} at scale ${c.scale}`);
        }
      } catch (error) {
        found.push(`${where}: threw ${String(error)}`);
      }
    }
  }
  return found;
}

const byFunction = new Map<string, Case[]>();
for (const c of fixture.cases) byFunction.set(c.fn, [...(byFunction.get(c.fn) ?? []), c]);

describe('decimal-math is correctly rounded (mpmath reference)', () => {
  it('covers every function with random, near-tie and exact cases', () => {
    expect([...byFunction.keys()].toSorted()).toEqual(Object.keys(FUNCTIONS).toSorted());
    const kinds = new Set(fixture.cases.map(c => c.kind.split(' ')[0]));
    expect(kinds).toEqual(new Set(['random', 'near-tie', 'exact']));
  });

  for (const [fn, cases] of byFunction) {
    it(`${fn}: ${cases.length} cases × ${modes.length} rounding modes match exactly`, () => {
      expect(mismatches(cases)).toEqual([]);
    });
  }
});
