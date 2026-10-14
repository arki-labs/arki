import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RoundingMode } from './rounding.js';
import { decimal } from './decimal.js';
import { roundExact, roundToExact } from './internal/round.js';
import { round, roundTo, roundToSignificant } from './number.js';
import { ROUNDING_MODES } from './rounding.js';

// Seeded, so every run checks the same cases and a failure prints a replayable seed and path.
// For a deep run raise the case count: MATH_PROPERTY_RUNS=20000 bun run test.
// The package compiles without Node types (it runs on every runtime); the test runner is Node.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
const RUNS = Math.max(1000, Number(process.env.MATH_PROPERTY_RUNS) || 0);
const config = { seed: 20_261_014, numRuns: RUNS };

/** The value, or the name of the error class, so that "both throw the same error" also matches. */
function outcome(run: () => number): number | string {
  try {
    return run();
  } catch (error) {
    return error instanceof Error ? error.constructor.name : 'non-Error throw';
  }
}

/**
 * Doubles from every corner: any finite double (subnormals and 1e308 included),
 * short decimals like 1.005 that sit on or next to a tie, and their neighbours.
 */
const doubleArb = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc
    .tuple(fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }), fc.integer({ min: 0, max: 20 }))
    .map(([digits, places]) => Number(`${digits}e-${places}`)),
  fc
    .tuple(fc.integer({ min: -99_999, max: 99_999 }), fc.integer({ min: 0, max: 18 }))
    .map(([digits, places]) => Number(`${digits}5e-${places + 1}`)),
  fc.bigInt({ min: -(2n ** 60n), max: 2n ** 60n }).map(Number),
);
const modeArb = fc.constantFrom<RoundingMode>(...ROUNDING_MODES);

function expectNoNegativeZero(value: number | string): void {
  if (typeof value === 'number') expect(Object.is(value, -0)).toBe(false);
}

describe('number rounding properties: the fast paths agree with the exact oracle', () => {
  it('round(x, places, mode) equals roundExact for every mode and never returns -0', () => {
    fc.assert(
      fc.property(doubleArb, fc.integer({ min: -25, max: 25 }), modeArb, (x, places, mode) => {
        const actual = outcome(() => round(x, places, mode));
        expect(actual).toStrictEqual(outcome(() => roundExact(x, places, mode)));
        expectNoNegativeZero(actual);
      }),
      config,
    );
  });

  it('roundTo(x, step, mode) equals roundToExact for every mode and never returns -0', () => {
    const stepArb = fc.oneof(
      fc.constantFrom(0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 100, 0.001, 0.125, 1e-9, 1e6),
      fc
        .tuple(fc.integer({ min: 1, max: 99_999 }), fc.integer({ min: -6, max: 12 }))
        .map(([digits, exponent]) => Number(`${digits}e${-exponent}`)),
    );
    const valueArb = fc.oneof(
      doubleArb.filter(x => Math.abs(x) < 1e15),
      fc.double({ min: -1e6, max: 1e6, noNaN: true }),
    );
    fc.assert(
      fc.property(valueArb, stepArb, modeArb, (x, step, mode) => {
        const actual = outcome(() => roundTo(x, step, mode));
        expect(actual).toStrictEqual(outcome(() => roundToExact(x, step, mode)));
        expectNoNegativeZero(actual);
      }),
      config,
    );
  });

  it('roundToSignificant equals exact Decimal rounding of the shortest text, and never returns -0', () => {
    fc.assert(
      fc.property(doubleArb, fc.integer({ min: 1, max: 20 }), modeArb, (x, digits, mode) => {
        const actual = outcome(() => roundToSignificant(x, digits, mode));
        const expected = outcome(() => {
          const value = Number(decimal(String(x)).roundToSignificant(digits, mode).toString());
          return value === 0 ? 0 : value;
        });
        // The oracle cannot represent overflow past the largest double; both must fail then.
        if (expected === Infinity || expected === -Infinity) {
          expect(actual).toBe('NumericRangeError');
        } else {
          expect(actual).toStrictEqual(expected);
        }
        expectNoNegativeZero(actual);
      }),
      config,
    );
  });
});
