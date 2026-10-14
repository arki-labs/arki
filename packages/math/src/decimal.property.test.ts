import { Decimal as DecimalJs } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RoundingMode } from './rounding.js';
import { sqrt } from './decimal-math.js';
import { Decimal, decimal } from './decimal.js';
import { RoundingNecessaryError } from './errors.js';
import { ROUNDING_MODES } from './rounding.js';

// Seeded, so every run checks the same cases and a failure prints a replayable seed and path.
// For a deep run raise the case count: MATH_PROPERTY_RUNS=20000 bun run test.
// The package compiles without Node types (it runs on every runtime); the test runner is Node.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
const RUNS = Math.max(300, Number(process.env.MATH_PROPERTY_RUNS) || 0);
const config = { seed: 20_261_014, numRuns: RUNS };

type DirectedMode = Exclude<RoundingMode, 'unnecessary'>;
const DIRECTED_MODES = ROUNDING_MODES.filter((mode): mode is DirectedMode => mode !== 'unnecessary');

// ---------------------------------------------------------------------------
// Oracle: rounding a bigint quotient, written from the definitions of the modes
// (truncate, then step away from zero when the mode says so). Shares no code with
// the library.
// ---------------------------------------------------------------------------

function oracleDivide(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  const truncated = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return truncated;
  if (mode === 'unnecessary') throw new Error('oracle: inexact under unnecessary');
  const negative = numerator < 0n !== denominator < 0n;
  const away = negative ? truncated - 1n : truncated + 1n;
  const twice = 2n * (remainder < 0n ? -remainder : remainder);
  const divisor = denominator < 0n ? -denominator : denominator;
  switch (mode) {
    case 'up': {
      return away;
    }
    case 'down': {
      return truncated;
    }
    case 'ceiling': {
      return negative ? truncated : away;
    }
    case 'floor': {
      return negative ? away : truncated;
    }
    case 'halfUp': {
      return twice >= divisor ? away : truncated;
    }
    case 'halfDown': {
      return twice > divisor ? away : truncated;
    }
    case 'halfEven': {
      return twice > divisor || (twice === divisor && truncated % 2n !== 0n) ? away : truncated;
    }
  }
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Plain text for `coefficient × 10^-scale`, built by hand (not by the library). */
function textOf(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const point = digits.length - scale;
  const body = scale === 0 ? digits : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${body}` : body;
}

function digitCount(value: bigint): number {
  return (value < 0n ? -value : value).toString().length;
}

// ---------------------------------------------------------------------------
// Arbitraries. Small coefficients are mixed in so that ties and equal values occur.
// ---------------------------------------------------------------------------

function coefficientArb(maxDigits: number): fc.Arbitrary<bigint> {
  const max = pow10(maxDigits);
  return fc.oneof(fc.bigInt({ min: -999n, max: 999n }), fc.bigInt({ min: -max, max }));
}

function decimalArb(maxDigits = 40, maxScale = 30): fc.Arbitrary<Decimal> {
  return fc
    .record({ coefficient: coefficientArb(maxDigits), scale: fc.integer({ min: 0, max: maxScale }) })
    .map(({ coefficient, scale }) => decimal(textOf(coefficient, scale)));
}

const anyDecimal = decimalArb();
const nonZeroDecimal = anyDecimal.filter(d => !d.isZero());
const modeArb = fc.constantFrom(...DIRECTED_MODES);

// ---------------------------------------------------------------------------

describe('Decimal properties: text', () => {
  it('parses plain text into exactly its coefficient and scale, and prints it back unchanged', () => {
    fc.assert(
      fc.property(coefficientArb(60), fc.integer({ min: 0, max: 60 }), (coefficient, scale) => {
        const text = textOf(coefficient, scale);
        const value = decimal(text);
        expect(value.coefficient).toBe(coefficient);
        expect(value.scale).toBe(scale);
        expect(value.toString()).toBe(text);
        expect(decimal(value.toString()).toString()).toBe(text);
      }),
      config,
    );
  });

  it('reads exponent notation as the same value', () => {
    fc.assert(
      fc.property(coefficientArb(40), fc.integer({ min: -30, max: 30 }), (coefficient, exponent) => {
        const value = decimal(`${coefficient}e${exponent}`);
        const expected =
          exponent >= 0 ? decimal(textOf(coefficient * pow10(exponent), 0)) : decimal(textOf(coefficient, -exponent));
        expect(value.eq(expected)).toBe(true);
      }),
      config,
    );
  });
});

describe('Decimal properties: exact arithmetic laws', () => {
  it('minus undoes plus, exactly, at the larger scale', () => {
    fc.assert(
      fc.property(anyDecimal, anyDecimal, (a, b) => {
        const back = a.plus(b).minus(b);
        expect(back.eq(a)).toBe(true);
        expect(back.scale).toBe(Math.max(a.scale, b.scale));
      }),
      config,
    );
  });

  it('plus and times are commutative (same digits and scale)', () => {
    fc.assert(
      fc.property(anyDecimal, anyDecimal, (a, b) => {
        expect(a.plus(b).toString()).toBe(b.plus(a).toString());
        expect(a.times(b).toString()).toBe(b.times(a).toString());
      }),
      config,
    );
  });

  it('plus and times are associative (same digits and scale)', () => {
    fc.assert(
      fc.property(anyDecimal, anyDecimal, anyDecimal, (a, b, c) => {
        expect(a.plus(b).plus(c).toString()).toBe(a.plus(b.plus(c)).toString());
        expect(a.times(b).times(c).toString()).toBe(a.times(b.times(c)).toString());
      }),
      config,
    );
  });

  it('times distributes over plus', () => {
    fc.assert(
      fc.property(anyDecimal, anyDecimal, anyDecimal, (a, b, c) => {
        expect(a.times(b.plus(c)).eq(a.times(b).plus(a.times(c)))).toBe(true);
      }),
      config,
    );
  });

  it('an exact dividedBy times the divisor gives back the dividend; otherwise it throws RoundingNecessaryError', () => {
    fc.assert(
      fc.property(anyDecimal, nonZeroDecimal, (a, b) => {
        // a / b = (ca · 10^sb) / (cb · 10^sa): terminating iff the reduced denominator is 2^i · 5^j.
        const numerator = a.coefficient * pow10(b.scale);
        let denominator = b.coefficient * pow10(a.scale);
        let x = numerator < 0n ? -numerator : numerator;
        let y = denominator < 0n ? -denominator : denominator;
        while (y !== 0n) [x, y] = [y, x % y];
        denominator /= x;
        let rest = denominator < 0n ? -denominator : denominator;
        while (rest % 2n === 0n) rest /= 2n;
        while (rest % 5n === 0n) rest /= 5n;
        if (rest === 1n) {
          expect(a.dividedBy(b).times(b).eq(a)).toBe(true);
        } else {
          expect(() => a.dividedBy(b)).toThrow(RoundingNecessaryError);
        }
      }),
      config,
    );
  });
});

describe('Decimal properties: rounding against a BigInt oracle', () => {
  it('dividedBy with { scale, rounding } rounds the exact quotient like the oracle, in every mode', () => {
    fc.assert(
      fc.property(anyDecimal, nonZeroDecimal, fc.integer({ min: 0, max: 40 }), modeArb, (a, b, scale, rounding) => {
        const result = a.dividedBy(b, { scale, rounding });
        const expected = oracleDivide(a.coefficient * pow10(b.scale + scale), b.coefficient * pow10(a.scale), rounding);
        expect(result.scale).toBe(scale);
        expect(result.coefficient).toBe(expected);
      }),
      config,
    );
  });

  it("dividedBy with rounding 'unnecessary' throws exactly when digits would be lost", () => {
    fc.assert(
      fc.property(anyDecimal, nonZeroDecimal, fc.integer({ min: 0, max: 40 }), (a, b, scale) => {
        const numerator = a.coefficient * pow10(b.scale + scale);
        const denominator = b.coefficient * pow10(a.scale);
        if (numerator % denominator === 0n) {
          expect(a.dividedBy(b, { scale, rounding: 'unnecessary' }).coefficient).toBe(numerator / denominator);
        } else {
          expect(() => a.dividedBy(b, { scale, rounding: 'unnecessary' })).toThrow(RoundingNecessaryError);
        }
      }),
      config,
    );
  });

  it('round and toScale match the oracle; padding never changes the value', () => {
    fc.assert(
      fc.property(anyDecimal, fc.integer({ min: 0, max: 40 }), modeArb, (value, places, rounding) => {
        const rounded = value.round(places, rounding);
        expect(rounded.scale).toBe(places);
        expect(value.toScale(places, rounding).toString()).toBe(rounded.toString());
        if (places >= value.scale) {
          expect(rounded.eq(value)).toBe(true);
        } else {
          expect(rounded.coefficient).toBe(oracleDivide(value.coefficient, pow10(value.scale - places), rounding));
        }
      }),
      config,
    );
  });
});

describe('Decimal properties: comparison', () => {
  it('compareTo agrees with the sign of the difference, and eq/lt/gt with compareTo', () => {
    fc.assert(
      fc.property(anyDecimal, anyDecimal, (a, b) => {
        const order = a.compareTo(b);
        expect(order).toBe(a.minus(b).sign());
        expect(b.compareTo(a) === -order).toBe(true);
        expect(a.eq(b)).toBe(order === 0);
        expect(a.lt(b)).toBe(order < 0);
        expect(a.gt(b)).toBe(order > 0);
        expect(a.lte(b)).toBe(order <= 0);
        expect(a.gte(b)).toBe(order >= 0);
        expect(Decimal.compare(a, b)).toBe(order);
      }),
      config,
    );
  });
});

// ---------------------------------------------------------------------------
// Differential: decimal.js at 60 significant digits. decimal.js rounds every
// result correctly to `precision` digits, so the library's exact (or scale-rounded)
// result, rounded to the same 60 significant digits with the same mode, must equal it.
// ---------------------------------------------------------------------------

const DECIMAL_JS_MODE: Record<DirectedMode, DecimalJs.Rounding> = {
  up: DecimalJs.ROUND_UP,
  down: DecimalJs.ROUND_DOWN,
  ceiling: DecimalJs.ROUND_CEIL,
  floor: DecimalJs.ROUND_FLOOR,
  halfUp: DecimalJs.ROUND_HALF_UP,
  halfDown: DecimalJs.ROUND_HALF_DOWN,
  halfEven: DecimalJs.ROUND_HALF_EVEN,
};

const SIGNIFICANT = 60;
const decimalJsByMode = new Map(
  DIRECTED_MODES.map(mode => [
    mode,
    DecimalJs.clone({ precision: SIGNIFICANT, rounding: DECIMAL_JS_MODE[mode], toExpNeg: -9e15, toExpPos: 9e15 }),
  ]),
);

/** A decimal.js constructor that rounds to 60 significant digits in `mode`. */
function decimalJs(mode: DirectedMode): typeof DecimalJs {
  const constructor = decimalJsByMode.get(mode);
  if (constructor === undefined) throw new Error(`no decimal.js clone for ${mode}`);
  return constructor;
}

function sameValue(ours: Decimal, theirs: DecimalJs): boolean {
  return new DecimalJs(ours.toString()).eq(theirs);
}

/** The power of ten of the leading digit of a value truncated at a generous scale. */
function leadingExponent(truncated: Decimal): number {
  return digitCount(truncated.coefficient) - 1 - truncated.scale;
}

describe('Decimal properties: differential against decimal.js at 60 significant digits', () => {
  it('plus and times', () => {
    fc.assert(
      fc.property(anyDecimal, anyDecimal, modeArb, (a, b, mode) => {
        const D = decimalJs(mode);
        const sum = a.plus(b);
        const product = a.times(b);
        expect(sameValue(sum.roundToSignificant(SIGNIFICANT, mode), new D(a.toString()).plus(b.toString()))).toBe(true);
        expect(sameValue(product.roundToSignificant(SIGNIFICANT, mode), new D(a.toString()).times(b.toString()))).toBe(
          true,
        );
      }),
      config,
    );
  });

  // Operands of at most 25 digits and scale 20 keep the quotient within 10^±45, so
  // 60 significant digits always need a non-negative scale.
  const divisionOperand = decimalArb(25, 20);

  it('dividedBy, in every rounding mode', () => {
    fc.assert(
      fc.property(
        divisionOperand.filter(d => !d.isZero()),
        divisionOperand.filter(d => !d.isZero()),
        modeArb,
        (a, b, mode) => {
          const exponent = leadingExponent(a.dividedBy(b, { scale: 120, rounding: 'down' }));
          const ours = a.dividedBy(b, { scale: SIGNIFICANT - 1 - exponent, rounding: mode });
          const theirs = new (decimalJs(mode))(a.toString()).dividedBy(b.toString());
          expect(sameValue(ours, theirs)).toBe(true);
        },
      ),
      config,
    );
  });

  it('sqrt, in every rounding mode', () => {
    fc.assert(
      fc.property(
        anyDecimal.filter(d => d.isPositive()),
        modeArb,
        (a, mode) => {
          const exponent = leadingExponent(sqrt(a, { scale: 120, rounding: 'down' }));
          const ours = sqrt(a, { scale: SIGNIFICANT - 1 - exponent, rounding: mode });
          const theirs = new (decimalJs(mode))(a.toString()).sqrt();
          expect(sameValue(ours, theirs)).toBe(true);
        },
      ),
      config,
    );
  });
});

describe('Decimal properties: round trip at the digit cap', () => {
  it('parses every Decimal back from its own toString(), up to 10 000 digits and scale 10 000', () => {
    const LIMIT = 10_000;
    const coefficient = fc
      .integer({ min: 1, max: LIMIT })
      .chain(digits => fc.bigInt({ min: 1n - pow10(digits), max: pow10(digits) - 1n }));
    fc.assert(
      fc.property(coefficient, fc.integer({ min: 0, max: LIMIT }), (c, scale) => {
        const value = decimal(c).times(`1e-${scale}`);
        const back = decimal(value.toString());
        expect(back.eq(value)).toBe(true);
        expect(back.scale).toBe(value.scale);
      }),
      config,
    );
  });
});
