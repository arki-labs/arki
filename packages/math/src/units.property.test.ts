import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Unit, UnitCategory } from './units.js';
import { ratio } from './rational.js';
import { convert, convertExact, joinUnits, splitUnits, unitsOf } from './units.js';

// Seeded, so every run checks the same cases and a failure prints a replayable seed and path.
// For a deep run raise the case count: MATH_PROPERTY_RUNS=20000 bun run test.
// The package compiles without Node types (it runs on every runtime); the test runner is Node.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
const RUNS = Math.max(500, Number(process.env.MATH_PROPERTY_RUNS) || 0);
const config = { seed: 20_261_014, numRuns: RUNS };

const CATEGORIES: readonly UnitCategory[] = [
  'length',
  'mass',
  'area',
  'volume',
  'temperature',
  'time',
  'speed',
  'data',
  'energy',
  'pressure',
  'angle',
  'solidAngle',
  'power',
  'frequency',
  'force',
  'torque',
  'fuelEconomy',
  'dataRate',
  'electricCurrent',
  'illuminance',
  'radioactivity',
  'dynamicViscosity',
  'kinematicViscosity',
];

/** Two units of one category (possibly the same). */
const unitPairArb = fc
  .constantFrom(...CATEGORIES)
  .chain(category => fc.tuple(fc.constantFrom(...unitsOf(category)), fc.constantFrom(...unitsOf(category))));

// Values that stay away from 0 for fuel economy (0 l/100km has no mpg equivalent) and
// from the extremes where a factor of 1e±20 would overflow a double.
const valueArb = fc
  .double({ min: 1e-6, max: 1e9, noNaN: true })
  .chain(magnitude => fc.constantFrom(magnitude, -magnitude));

/** Pairs whose ratio involves π (radian, steradian, the IAU parsec = 648000/π au): no exact result. */
function isPiPair(from: Unit, to: Unit): boolean {
  const pi = new Set<Unit>(['rad', 'sr', 'pc']);
  return from !== to && (pi.has(from) || pi.has(to));
}

describe('units properties', () => {
  it('convert there and back gives the value back to within float rounding', () => {
    fc.assert(
      fc.property(unitPairArb, valueArb, ([from, to], value) => {
        const back = convert(convert(value, from, to), to, from);
        // Temperature is affine: converting -459.67 °F style offsets loses digits relative to the value.
        const scale = Math.max(Math.abs(value), from === 'K' || to === 'K' || from === 'F' || to === 'F' ? 500 : 0);
        expect(Math.abs(back - value)).toBeLessThanOrEqual(scale * 1e-12);
      }),
      config,
    );
  });

  it('convertExact there and back is exact', () => {
    fc.assert(
      fc.property(
        unitPairArb.filter(([from, to]) => !isPiPair(from, to)),
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }).filter(n => n !== 0n),
        fc.bigInt({ min: 1n, max: 10n ** 6n }),
        ([from, to], numerator, denominator) => {
          const value = ratio(numerator, denominator);
          expect(convertExact(convertExact(value, from, to), to, from).eq(value)).toBe(true);
        },
      ),
      config,
    );
  });

  it('convert agrees with convertExact to within float rounding', () => {
    fc.assert(
      fc.property(
        unitPairArb.filter(([from, to]) => !isPiPair(from, to)),
        fc.integer({ min: -1_000_000, max: 1_000_000 }).filter(n => n !== 0),
        ([from, to], value) => {
          const exact = convertExact(value, from, to).toNumber();
          const float = convert(value, from, to);
          expect(Math.abs(float - exact)).toBeLessThanOrEqual(Math.max(Math.abs(exact), 500) * 1e-12);
        },
      ),
      config,
    );
  });

  const LADDERS: readonly (readonly Unit[])[] = [
    ['mi', 'yd', 'ft', 'in'],
    ['ft', 'in'],
    ['km', 'm', 'cm', 'mm'],
    ['st', 'lb', 'oz'],
    ['wk', 'd', 'h', 'min', 's'],
    ['deg', 'arcmin', 'arcsec'],
  ];

  it('joinUnits(splitUnits(x)) gives x back; every part but the last is a whole number', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LADDERS),
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        fc.integer({ min: 0, max: 3 }),
        (units, hundredths, scale) => {
          const last = units.at(-1);
          if (last === undefined) return;
          const value = ratio(BigInt(hundredths), 100n);
          const parts = splitUnits(value, last, units);
          expect(parts.map(part => part.unit)).toStrictEqual([...units]);
          for (const part of parts.slice(0, -1)) expect(Number.isInteger(part.value)).toBe(true);
          expect(joinUnits(parts, last)).toBeCloseTo(value.toNumber(), 9);
          // With a scale, the rounded remainder carries: the last part stays below one of the unit above it.
          const rounded = splitUnits(value, last, units, { scale });
          const lastPart = rounded.at(-1);
          const above = units.at(-2);
          if (lastPart !== undefined && above !== undefined) {
            expect(Math.abs(lastPart.value)).toBeLessThan(convert(1, above, last));
          }
        },
      ),
      config,
    );
  });
});
