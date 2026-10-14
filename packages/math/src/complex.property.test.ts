import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Complex } from './complex.js';
import { complex } from './complex.js';

// Seeded, so every run checks the same cases and a failure prints a replayable seed and path.
// For a deep run raise the case count: MATH_PROPERTY_RUNS=20000 bun run test.
// The package compiles without Node types (it runs on every runtime); the test runner is Node.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
const RUNS = Math.max(500, Number(process.env.MATH_PROPERTY_RUNS) || 0);
const config = { seed: 20_261_014, numRuns: RUNS };

/** Relative to the size of the operands, absolute near zero (`Complex#approxEqual`). */
const TOLERANCE = 1e-12;

function expectClose(actual: Complex, expected: Complex, scale = 1): void {
  const distance = Math.hypot(actual.re - expected.re, actual.im - expected.im);
  const size = Math.max(1, actual.abs(), expected.abs(), scale);
  expect(distance, `${actual.toString()} ≈ ${expected.toString()}`).toBeLessThanOrEqual(TOLERANCE * size);
}

const partArb = fc.oneof(
  fc.integer({ min: -20, max: 20 }),
  fc.double({ min: -1e3, max: 1e3, noNaN: true }),
  fc.double({ min: -1e-3, max: 1e-3, noNaN: true }),
  // Subnormal and near-underflow parts: the bottom of the float range.
  fc.double({ min: -1e-300, max: 1e-300, noNaN: true }),
);
const complexArb = fc.tuple(partArb, partArb).map(([re, im]) => complex(re, im));
const nonZeroArb = complexArb.filter(z => z.abs() > 1e-6);

describe('Complex properties: field laws within float tolerance', () => {
  it('plus and times are commutative; times distributes over plus', () => {
    fc.assert(
      fc.property(complexArb, complexArb, complexArb, (a, b, c) => {
        expect(a.plus(b).eq(b.plus(a))).toBe(true);
        expect(a.times(b).eq(b.times(a))).toBe(true);
        expectClose(a.plus(b).plus(c), a.plus(b.plus(c)), a.abs() + b.abs() + c.abs());
        const products = a.abs() * (b.abs() + c.abs());
        expectClose(a.times(b.plus(c)), a.times(b).plus(a.times(c)), products);
        expectClose(a.times(b).times(c), a.times(b.times(c)), a.abs() * b.abs() * c.abs());
      }),
      config,
    );
  });

  it('z · z⁻¹ ≈ 1 and (a / b) · b ≈ a', () => {
    fc.assert(
      fc.property(complexArb, nonZeroArb, (a, b) => {
        expectClose(b.times(b.inverse()), complex(1, 0));
        expectClose(a.dividedBy(b).times(b), a);
      }),
      config,
    );
  });

  it('conjugation: conj(a + b) = conj a + conj b, conj(a · b) = conj a · conj b, z · conj z = |z|²', () => {
    fc.assert(
      fc.property(complexArb, complexArb, (a, b) => {
        expect(a.plus(b).conjugate().eq(a.conjugate().plus(b.conjugate()))).toBe(true);
        expectClose(a.times(b).conjugate(), a.conjugate().times(b.conjugate()), a.abs() * b.abs());
        expect(a.conjugate().conjugate().eq(a)).toBe(true);
        const norm = a.times(a.conjugate());
        expect(norm.im).toBe(0);
        expectClose(norm, complex(a.abs() ** 2, 0));
      }),
      config,
    );
  });

  it('sqrt is the principal root: re ≥ 0 and sqrt(z)² ≈ z', () => {
    fc.assert(
      fc.property(complexArb, z => {
        const root = z.sqrt();
        expect(root.re >= 0).toBe(true);
        expectClose(root.times(root), z);
        // Relative check that also bites for tiny z: |√z| = √|z|. The reference scales a tiny z
        // up first (exact), because |z| of a subnormal z is itself rounded to a few bits.
        const scale = z.abs() < 1e-200 ? 2 ** 600 : 1;
        const modulus = Math.sqrt(Math.hypot(z.re * scale, z.im * scale)) / Math.sqrt(scale);
        expect(Math.abs(root.abs() - modulus)).toBeLessThanOrEqual(1e-15 * modulus);
      }),
      config,
    );
  });

  // Found by the property above (5000 runs): |re| + |z| of a subnormal z halves to 0, so t = 0 and
  // im / 2t overflowed into "sqrt overflows the float range". √(−5e-324 i) = 2^-537 · (1 − i)/√2.
  it('regression: sqrt of a subnormal number does not underflow to a division by zero', () => {
    const part = 2 ** -537 * Math.SQRT1_2;
    for (const [z, expected] of [
      [complex(0, -5e-324), complex(part, -part)],
      [complex(0, 5e-324), complex(part, part)],
      [complex(5e-324, 0), complex(2 ** -537, 0)],
      [complex(-5e-324, 0), complex(0, 2 ** -537)],
    ] as const) {
      const root = z.sqrt();
      expect(Math.abs(root.re - expected.re)).toBeLessThanOrEqual(1e-15 * 2 ** -537);
      expect(Math.abs(root.im - expected.im)).toBeLessThanOrEqual(1e-15 * 2 ** -537);
    }
  });
});
