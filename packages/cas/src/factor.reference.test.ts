/**
 * `factor` against SymPy (fixtures/factor.json, built by
 * test/reference/gen_factor.py): for every polynomial, the same content and
 * the same irreducible factors with the same multiplicities, exactly. The set
 * holds cyclotomic, Swinnerton-Dyer (recombination stress) and Mignotte-style
 * polynomials and seeded random products up to degree 40 with 30-digit
 * coefficients. Each case must also finish within 1 s (RFC §13).
 */
import { describe, expect, it } from 'vitest';

import { parse } from '@arki/expr';
import { orThrow } from '@arki/failure';
import { Rational } from '@arki/math/rational';

import fixture from '../test/reference/fixtures/factor.json' with { type: 'json' };
import { factor, fastest, polynomialIn } from './test-support.js';

function text(coefficients: readonly string[]): string {
  return coefficients.map((c, k) => `(${c})*x^${k}`).join(' + ');
}

/** Ascending coefficients of a factor, as exact rational strings. */
function coefficientsOf(source: string): string[] {
  const form = polynomialIn(source, 'x');
  if (form.kind !== 'polynomial') throw new Error(`not a polynomial: ${source}`);
  return form.coefficients.map(c => c.rational?.toString() ?? 'non-rational');
}

/** Shorter factors first, then by coefficient text. */
function order(a: { coefficients: string[] }, b: { coefficients: string[] }): number {
  return (
    a.coefficients.length - b.coefficients.length || (a.coefficients.join(',') < b.coefficients.join(',') ? -1 : 1)
  );
}

describe('factor against SymPy', () => {
  for (const c of fixture.cases) {
    it(`${c.name} (degree ${c.input.length - 1})`, () => {
      // The largest inputs are longer than expr's default 10 000-character parse budget.
      const input = orThrow(parse(text(c.input), { limits: { length: 100_000, tokens: 100_000 } }));
      // Two random products have ~380-digit coefficients, over the default factorDigits budget of 300.
      const timed = fastest(() => factor(input, 'x', { limits: { factorDigits: 1000 } }), 1000);
      expect(timed.ms).toBeLessThan(1000);
      if (!timed.ok) throw timed.error;
      const result = timed.value;
      expect(result.complete).toBe(true);
      expect(Rational.from(result.content.source.replaceAll(/\s/gu, '')).eq(Rational.from(c.content))).toBe(true);
      const got = result.factors.map(f => ({
        coefficients: coefficientsOf(f.factor.source),
        multiplicity: f.multiplicity,
      }));
      const expected = c.factors.map(f => ({
        coefficients: f.coefficients.map(k => Rational.from(k).toString()),
        multiplicity: f.multiplicity,
      }));
      expect(got.toSorted(order)).toEqual(expected.toSorted(order));
    });
  }
});
