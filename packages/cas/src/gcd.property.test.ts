/**
 * `gcd` properties (RFC §13), with fast-check, on A·C and B·C for random
 * integer polynomials A, B, C. With g = gcd(A·C, B·C):
 * 1. g divides both inputs, and C divides g (division over ℚ leaves a polynomial);
 * 2. the cofactors A·C/g and B·C/g have gcd 1, so no larger divisor exists;
 * 3. g is monic, as documented for one generator.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { gcd, polynomialIn } from './polynomial.js';

const polynomial = fc
  .tuple(fc.array(fc.integer({ min: -12, max: 12 }), { minLength: 1, maxLength: 6 }), fc.integer({ min: 1, max: 9 }))
  .map(([low, lead]) => [...low, lead].map((c, k) => `(${c})*x^${k}`).join(' + '));

/** True when `p / q` is a polynomial in x, that is when q divides p over ℚ. */
function divides(q: string, p: string): boolean {
  return polynomialIn(`(${p}) / (${q})`, 'x').kind === 'polynomial';
}

describe('gcd properties', () => {
  it('gcd(A·C, B·C) divides both, is divisible by C, leaves coprime cofactors and is monic', () => {
    fc.assert(
      fc.property(polynomial, polynomial, polynomial, (a, b, c) => {
        const [ac, bc] = [`(${a}) * (${c})`, `(${b}) * (${c})`];
        const g = gcd(ac, bc).result.source;
        expect(divides(g, ac) && divides(g, bc)).toBe(true);
        expect(divides(c, g)).toBe(true);
        expect(gcd(`(${ac}) / (${g})`, `(${bc}) / (${g})`).result.source).toBe('1');
        const form = polynomialIn(g, 'x');
        expect(form.kind === 'polynomial' ? form.coefficients.at(-1)?.rational?.toString() : form.kind).toBe('1');
      }),
      { numRuns: 200 },
    );
  });
});
