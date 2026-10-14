import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { decimal } from './decimal.js';
import { MathError } from './errors.js';
import { fromBase } from './integer.js';
import { parseDecimal, parseNumber } from './parse.js';
import { ratio } from './rational.js';

// Seeded, so every run checks the same cases and a failure prints a replayable seed and path.
// For a deep run raise the case count: MATH_PROPERTY_RUNS=20000 bun run test.
// The package compiles without Node types (it runs on every runtime); the test runner is Node.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
const RUNS = Math.max(300, Number(process.env.MATH_PROPERTY_RUNS) || 0);
const config = { seed: 20_261_014, numRuns: RUNS };

/** Generous per-call budget: a resource limit answers in milliseconds, a missing one takes seconds. */
const BUDGET_MS = 1000;

/**
 * Untrusted input must either produce a value or throw a typed `MathError`, quickly.
 * A `TypeError`, `RangeError` or `SyntaxError` escaping from the engine is a bug.
 */
function expectReturnsOrMathError(run: () => unknown): void {
  const started = Date.now();
  try {
    run();
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(MathError);
  }
  expect(Date.now() - started).toBeLessThan(BUDGET_MS);
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
