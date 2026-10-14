import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Decimal, decimal } from './decimal.js';
import { MathError, ResourceLimitError } from './errors.js';
import { fromBase } from './integer.js';
import { parseDecimal, parseNumber } from './parse.js';
import { ratio } from './rational.js';

// Seeded, so every run checks the same cases and a failure prints a replayable seed and path.
// For a deep run raise the case count: MATH_PROPERTY_RUNS=20000 bun run test.
// The package compiles without Node types (it runs on every runtime); the test runner is Node.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
const RUNS = Math.max(300, Number(process.env.MATH_PROPERTY_RUNS) || 0);
const config = { seed: 20_261_014, numRuns: RUNS };

/**
 * Generous per-call budget: a resource limit answers in milliseconds, a missing one takes
 * seconds to minutes. The worst legitimate call is a gcd of two 10_000-digit numbers (~0.5 s).
 */
const BUDGET_MS = 2000;

/**
 * Untrusted input must either produce a value or throw a typed `MathError`, quickly.
 * A `TypeError`, `RangeError` or `SyntaxError` escaping from the engine is a bug.
 * Returns the value, or `undefined` after a `MathError`.
 */
function attempt<T>(run: () => T): T | undefined {
  const started = Date.now();
  try {
    return run();
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(MathError);
    return undefined;
  } finally {
    expect(Date.now() - started).toBeLessThan(BUDGET_MS);
  }
}

function expectReturnsOrMathError(run: () => unknown): void {
  attempt(run);
}

const numericAlphabet = fc.constantFrom(...'0123456789.eE+-/ _, ٫٣');

/** Text in every shape: random code units, numeric-looking noise, and huge digit runs and exponents. */
const hostileText = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.string({ unit: numericAlphabet, maxLength: 40 }),
  fc
    .record({
      sign: fc.constantFrom('', '-', '+'),
      lead: fc.constantFrom('', '0.', '.'),
      digit: fc.constantFrom('0', '1', '9', 'z'),
      length: fc.integer({ min: 1, max: 30_000 }),
      exponent: fc.option(
        fc.oneof(
          fc.integer({ min: -20_000, max: 20_000 }).map(String),
          fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }).map(String),
        ),
      ),
      denominator: fc.option(fc.integer({ min: 1, max: 30_000 })),
    })
    .map(
      ({ sign, lead, digit, length, exponent, denominator }) =>
        `${sign}${lead}${digit.repeat(length)}${exponent === null ? '' : `e${exponent}`}` +
        (denominator === null ? '' : `/${'7'.repeat(denominator)}`),
    ),
);

describe('hostile inputs: parsing never hangs and only throws MathError', () => {
  it('decimal(text)', () => {
    fc.assert(
      fc.property(hostileText, text => expectReturnsOrMathError(() => decimal(text))),
      config,
    );
  });

  it('ratio(text), including "a/b" and "w a/b"', () => {
    fc.assert(
      fc.property(hostileText, hostileText, (a, b) => {
        expectReturnsOrMathError(() => ratio(a));
        expectReturnsOrMathError(() => ratio(`${a}/${b}`));
        expectReturnsOrMathError(() => ratio(`3 ${a}/${b}`));
      }),
      config,
    );
  });

  it('parseNumber and parseDecimal, in several locales', () => {
    fc.assert(
      fc.property(
        hostileText,
        fc.constantFrom('en-US', 'de-DE', 'fr-FR', 'ar-EG', 'hi-IN', 'default'),
        (text, locale) => {
          expectReturnsOrMathError(() => parseNumber(text, { locale }));
          expectReturnsOrMathError(() => parseDecimal(text, { locale }));
        },
      ),
      config,
    );
  });

  it('fromBase(text, base)', () => {
    fc.assert(
      fc.property(hostileText, fc.integer({ min: 2, max: 36 }), (text, base) =>
        expectReturnsOrMathError(() => fromBase(text, base)),
      ),
      config,
    );
  });
});

describe('hostile inputs: deep values never hang and only throw MathError', () => {
  type Value = ReturnType<typeof decimal> | ReturnType<typeof ratio>;

  /** One arithmetic step on a value and a second operand; every step can double the digits. */
  const steps: readonly ((x: Value, y: Value) => Value)[] = [
    (x, y) => (x instanceof Decimal ? x.times(x) : x.times(y)),
    x => (x instanceof Decimal ? x.times(x) : x.times(x)),
    (x, y) => (x instanceof Decimal ? x.plus(x) : x.plus(y.isZero() ? 1 : x.inverse())),
    (x, y) =>
      x instanceof Decimal
        ? x.dividedBy(y.isZero() ? 7 : decimal(y.toString()), { scale: 50, rounding: 'halfEven' })
        : x.dividedBy(y.isZero() ? 7 : y),
  ];

  const digits = fc
    .record({ digit: fc.constantFrom('1', '3', '7', '9'), length: fc.integer({ min: 1, max: 10_000 }) })
    .map(({ digit, length }) => digit.repeat(length));
  const valueArb = fc.oneof(
    digits.map(text => decimal(text)),
    fc.tuple(digits, fc.integer({ min: 0, max: 9999 })).map(([text, scale]) => decimal(`${text}e-${scale}`)),
    fc.tuple(digits, digits).map(([p, q]) => ratio(`${p}/${q}`)),
  );

  it('chains of times / plus / dividedBy on values at the size limits', () => {
    fc.assert(
      fc.property(
        valueArb,
        valueArb,
        fc.array(fc.integer({ min: 0, max: steps.length - 1 }), { minLength: 1, maxLength: 24 }),
        (start, other, plan) => {
          const second = start instanceof Decimal === other instanceof Decimal ? other : start;
          // The budget applies to each step; the chain stops at the first MathError.
          let x: Value | undefined = start;
          for (const index of plan) {
            const step = steps[index];
            const current: Value | undefined = x;
            if (step === undefined || current === undefined) break;
            x = attempt(() => step(current, second));
          }
        },
      ),
      { ...config, numRuns: Math.ceil(RUNS / 3) },
    );
  });

  // Found while probing deep values: parsing caps inputs at 10_000 digits, but nothing capped results,
  // so 14 squarings of a 10_000-digit value ran for ~6 s and ended in the engine's
  // "RangeError: Maximum BigInt size exceeded" instead of a ResourceLimitError.
  function expectSquaringStops<T extends { times(other: T): T }>(start: T): void {
    const started = Date.now();
    expect(() => {
      let x = start;
      for (let i = 0; i < 40; i++) x = x.times(x);
    }).toThrow(ResourceLimitError);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS);
  }

  it('regression: repeated squaring hits ResourceLimitError quickly (Decimal and Rational)', () => {
    expectSquaringStops(decimal('9'.repeat(10_000)));
    expectSquaringStops(ratio(`${'9'.repeat(10_000)}/7`));
  });

  it("regression: x + 1/x doubles a Rational's digits too, and also stops at the limit", () => {
    const started = Date.now();
    expect(() => {
      let x = ratio(`${'7'.repeat(6000)}/${'3'.repeat(6000)}`);
      for (let i = 0; i < 40; i++) x = x.plus(x.inverse());
    }).toThrow(ResourceLimitError);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS);
  });
});
