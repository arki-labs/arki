/**
 * `factor` properties (RFC §13), with fast-check, on products P = A·B of
 * random integer polynomials:
 * 1. content·∏ factorᵢ^mᵢ is P exactly;
 * 2. the factors of P are the factors of A and of B together (merged
 *    multiplicities), and content(P) = content(A)·content(B). A factor that
 *    was not irreducible would break the second property for some pairs.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Rational } from '@arki/math/rational';

import type { Factored } from './polynomial.js';
import { expand, factor } from './polynomial.js';

const polynomial = fc
  .tuple(fc.array(fc.integer({ min: -12, max: 12 }), { minLength: 1, maxLength: 6 }), fc.integer({ min: 1, max: 9 }))
  .map(([low, lead]) => [...low, lead].map((c, k) => `(${c})*x^${k}`).join(' + '));

function factorMap(f: Factored): Map<string, number> {
  const out = new Map<string, number>();
  for (const { factor: p, multiplicity } of f.factors) out.set(p.source, (out.get(p.source) ?? 0) + multiplicity);
  return out;
}

describe('factor properties', () => {
  it('content times the factors is the input; factors of A·B are those of A and B', () => {
    fc.assert(
      fc.property(polynomial, polynomial, (a, b) => {
        const product = `(${a}) * (${b})`;
        const [fp, fa, fb] = [factor(product, 'x'), factor(a, 'x'), factor(b, 'x')];
        expect(fp.complete).toBe(true);
        const rebuilt = [
          `(${fp.content.source})`,
          ...fp.factors.map(f => `(${f.factor.source})^${f.multiplicity}`),
        ].join(' * ');
        expect(expand(`${rebuilt} - (${product})`).result.source).toBe('0');
        const merged = factorMap(fa);
        for (const [p, m] of factorMap(fb)) merged.set(p, (merged.get(p) ?? 0) + m);
        expect(new Map([...factorMap(fp)].toSorted())).toEqual(new Map([...merged].toSorted()));
        const content = Rational.from(fa.content.source.replaceAll(' ', '')).times(
          Rational.from(fb.content.source.replaceAll(' ', '')),
        );
        expect(Rational.from(fp.content.source.replaceAll(' ', '')).eq(content)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
