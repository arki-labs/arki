/**
 * Whole-unit arithmetic. An amount is a count of whole units, held as a plain
 * `number` while it is a safe integer and as a `bigint` beyond that. Each value
 * has exactly one of the two forms ("canonical form"): a `number` if and only
 * if it is a safe integer, never `-0`.
 *
 * Plain numbers are several times faster than `bigint` on every engine, and
 * 2^53 cents is 90 trillion in a two-decimal currency, so almost every program
 * stays on the number path. The `bigint` path keeps the rest exact.
 */

import type { RoundingMode } from '@arki/math/rounding';
import { DivisionByZeroError, ResourceLimitError, RoundingNecessaryError } from '@arki/math/errors';

import { AmountOutOfRange, InputTooLarge, InvalidMoneyText } from '../failures.js';

export type Units = number | bigint;

const MAX = Number.MAX_SAFE_INTEGER;
const MAX_BIG = BigInt(Number.MAX_SAFE_INTEGER);

/** Largest number of decimals a `Money` or a custom currency may have. */
export const MAX_SCALE = 100;
/** Longest amount string that is parsed. */
export const MAX_INPUT_LENGTH = 1000;
/** Largest number of parts `allocate` and `split` produce. */
export const MAX_PARTS = 10_000;
/**
 * Largest amount, in decimal digits. An amount reaches this through repeated
 * `times` or a huge bigint, and past it a bigint product can crash Hermes with a
 * raw `RangeError`. Checked as hexadecimal digits, which is linear-time: 8 305 of
 * them hold 33 220 bits, which is 10 000 decimal digits.
 */
export const MAX_DIGITS = 10_000;
const MAX_HEX_DIGITS = Math.ceil((MAX_DIGITS * Math.log2(10)) / 4);

const POW10 = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15];

/** Hexadecimal digits of a `bigint` magnitude. Linear-time, unlike decimal `toString()`. */
function hexDigits(value: bigint): number {
  return (value < 0n ? -value : value).toString(16).length;
}

function tooManyDigits(): ResourceLimitError {
  return new ResourceLimitError(`An amount may have at most about ${MAX_DIGITS} digits`);
}

/** Whether a `bigint` has more than {@link MAX_DIGITS} decimal digits. */
export function exceedsDigits(value: bigint): boolean {
  return hexDigits(value) > MAX_HEX_DIGITS;
}

/** Whether `a × b` could pass {@link MAX_DIGITS}, the same test `mulUnits` throws `ResourceLimitError` on. */
export function productExceedsDigits(a: Units, b: Units): boolean {
  return hexDigits(BigInt(a)) + hexDigits(BigInt(b)) > MAX_HEX_DIGITS + 1;
}

/** Returns the value, or throws `ResourceLimitError` past {@link MAX_DIGITS} digits. */
function limitDigits(value: bigint): bigint {
  if (exceedsDigits(value)) throw tooManyDigits();
  return value;
}

/**
 * `a × b`, refused before it is built when it could pass {@link MAX_DIGITS}: the
 * product has at most as many hexadecimal digits as both factors together.
 */
function mulBig(a: bigint, b: bigint): bigint {
  if (hexDigits(a) + hexDigits(b) > MAX_HEX_DIGITS + 1) throw tooManyDigits();
  return a * b;
}

/** Brings a `bigint` to canonical form. */
export function canon(value: bigint): Units {
  return value >= -MAX_BIG && value <= MAX_BIG ? Number(value) : value;
}

/** `10^exponent` in canonical form. `exponent` is a small non-negative integer. */
export function pow10(exponent: number): Units {
  return POW10[exponent] ?? 10n ** BigInt(exponent);
}

/** Exact sum. */
export function addUnits(a: Units, b: Units): Units {
  if (typeof a === 'number' && typeof b === 'number') {
    const sum = a + b;
    // Two safe integers add exactly whenever the true sum is itself safe.
    if (sum <= MAX && sum >= -MAX) return sum;
  }
  return canon(limitDigits(BigInt(a) + BigInt(b)));
}

/** Exact product. */
export function mulUnits(a: Units, b: Units): Units {
  if (typeof a === 'number' && typeof b === 'number') {
    const product = a * b;
    // Float rounding never moves a value across 2^53, so a product that reads
    // as safe is the exact product. `+ 0` turns `-0` into `0`.
    if (product <= MAX && product >= -MAX) return product + 0;
  }
  return canon(mulBig(BigInt(a), BigInt(b)));
}

export function negUnits(a: Units): Units {
  return typeof a === 'number' ? 0 - a : -a;
}

/** `-1`, `0` or `1`. Mixed `number`/`bigint` comparison is exact in JavaScript. */
export function compareUnits(a: Units, b: Units): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The one rounding decision in the package. Given a truncated quotient, says
 * whether to step one further away from zero.
 *
 * `half` compares the dropped remainder with half the divisor: `-1` below,
 * `0` exactly half, `1` above. `odd` is whether the truncated quotient is odd.
 */
function roundsAway(mode: RoundingMode | undefined, negative: boolean, half: -1 | 0 | 1, odd: boolean): boolean {
  if (mode === 'halfEven') return half > 0 || (half === 0 && odd);
  if (mode === 'halfUp') return half >= 0;
  if (mode === 'halfDown') return half > 0;
  if (mode === 'down') return false;
  if (mode === 'up') return true;
  if (mode === 'ceiling') return !negative;
  if (mode === 'floor') return negative;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- plain JavaScript can pass a misspelled mode
  if (mode === undefined || mode === 'unnecessary') {
    throw new RoundingNecessaryError(
      'The exact result does not fit the requested precision; pass a rounding mode such as "halfEven"',
    );
  }
  // Reached only from plain JavaScript with a misspelled mode.
  throw new TypeError(`Unknown rounding mode: ${String(mode)}`);
}

/**
 * `units × numerator ÷ denominator` as a whole number, rounded with `mode`.
 * `denominator` must be positive. With no mode (or `'unnecessary'`) an inexact
 * result throws `RoundingNecessaryError`. Every operation that can lose digits
 * reduces to this call.
 */
export function mulDiv(units: Units, numerator: Units, denominator: Units, mode?: RoundingMode): Units {
  if (typeof units === 'number' && typeof numerator === 'number' && typeof denominator === 'number') {
    const product = units * numerator;
    if (product <= MAX && product >= -MAX) {
      // `%` on doubles is exact, so both the remainder and the quotient are.
      const remainder = product % denominator;
      if (remainder === 0) return product / denominator + 0;
      const quotient = (product - remainder) / denominator;
      const twice = (remainder < 0 ? -remainder : remainder) * 2;
      const half = twice > denominator ? 1 : twice < denominator ? -1 : 0;
      if (!roundsAway(mode, product < 0, half, quotient % 2 !== 0)) return quotient;
      return product < 0 ? quotient - 1 : quotient + 1;
    }
  }
  const product = mulBig(BigInt(units), BigInt(numerator));
  const divisor = BigInt(denominator);
  const quotient = product / divisor;
  const remainder = product - quotient * divisor;
  if (remainder === 0n) return canon(quotient);
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  const half = twice > divisor ? 1 : twice < divisor ? -1 : 0;
  if (!roundsAway(mode, product < 0n, half, (quotient & 1n) !== 0n)) return canon(quotient);
  return canon(product < 0n ? quotient - 1n : quotient + 1n);
}

/**
 * Brings `coefficient × 10^-fraction` onto the grid of `scale` decimals, and
 * onto multiples of `step` units when a step is given. Rounds once, never
 * first to the scale and then to the step.
 */
export function quantize(
  coefficient: Units,
  fraction: number,
  scale: number,
  mode?: RoundingMode,
  step?: Units,
): Units {
  if (step === undefined) {
    if (fraction === scale) return coefficient;
    if (fraction < scale) return mulUnits(coefficient, pow10(scale - fraction));
    return mulDiv(coefficient, 1, pow10(fraction - scale), mode);
  }
  const up = fraction < scale ? pow10(scale - fraction) : 1;
  const down = fraction > scale ? pow10(fraction - scale) : 1;
  return mulUnits(mulDiv(coefficient, up, mulUnits(down, step), mode), step);
}

/** A decimal read from text: `coefficient × 10^-fraction`, with `fraction >= 0`. */
export type Parsed = { coefficient: Units; fraction: number };

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d{1,4}))?$/i;

/**
 * Reads plain decimal text: an optional sign, digits, an optional fraction, an
 * optional exponent. No grouping, no spaces, no `Infinity`. Returns
 * `InvalidMoneyText` otherwise, and `InputTooLarge` past the length or exponent limit.
 */
export function parseDecimal(text: string) {
  if (text.length > MAX_INPUT_LENGTH) return InputTooLarge();
  const match = DECIMAL.exec(text);
  if (match === null) return InvalidMoneyText();
  const whole = match[2] ?? '';
  const fractionDigits = match[3] ?? '';
  const digits = whole + fractionDigits;
  const magnitude = digits.length <= 15 ? Number(digits) : canon(BigInt(digits));
  const coefficient = match[1] === '-' ? negUnits(magnitude) : magnitude;
  const fraction = fractionDigits.length - (match[4] === undefined ? 0 : Number(match[4]));
  if (fraction > MAX_INPUT_LENGTH || fraction < -MAX_INPUT_LENGTH) return InputTooLarge();
  const parsed: Parsed =
    fraction >= 0 ? { coefficient, fraction } : { coefficient: mulUnits(coefficient, pow10(-fraction)), fraction: 0 };
  return parsed;
}

/**
 * Reads a JS number through its shortest decimal spelling, so `19.99` means
 * exactly 19.99 — what was typed, not the binary approximation. It cannot undo
 * earlier float arithmetic: `0.1 + 0.2` arrives as `0.30000000000000004`.
 * `NaN`, infinities and integers past 2^53 (their digits are already lost) return `AmountOutOfRange`.
 */
export function parseNumber(value: number) {
  if (Number.isSafeInteger(value)) {
    const parsed: Parsed = { coefficient: value + 0, fraction: 0 };
    return parsed;
  }
  if (!Number.isFinite(value) || Number.isInteger(value)) return AmountOutOfRange();
  return parseDecimal(String(value));
}

const INTEGER = /^[+-]?\d+$/;

/**
 * Whole minor units from a safe-integer `number`, a `bigint`, or integer text (as
 * databases return `BIGINT`). Returns `AmountOutOfRange` for an unsafe or fractional
 * number, `InputTooLarge` past the digit or length limit, `InvalidMoneyText` otherwise.
 */
export function toUnits(value: number | bigint | string) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value + 0 : AmountOutOfRange();
  if (typeof value === 'bigint') return exceedsDigits(value) ? InputTooLarge() : canon(value);
  if (typeof value === 'string') {
    if (value.length > MAX_INPUT_LENGTH) return InputTooLarge();
    if (INTEGER.test(value)) return canon(BigInt(value));
  }
  return InvalidMoneyText();
}

/** Whether `coefficient × 10^-fraction` has no digits past `scale` decimals, so moving it there needs no rounding. */
export function isExactAtScale(coefficient: Units, fraction: number, scale: number): boolean {
  if (fraction <= scale) return true;
  const divisor = pow10(fraction - scale);
  if (typeof coefficient === 'number' && typeof divisor === 'number') return coefficient % divisor === 0;
  return BigInt(coefficient) % BigInt(divisor) === 0n;
}

/** Throws `DivisionByZeroError` for a zero divisor. */
export function assertNonZero(value: Units): void {
  if (value === 0 || value === 0n) throw new DivisionByZeroError('Division by zero');
}

/** Greatest common divisor of two non-negative values, in canonical form. */
export function gcdUnits(a: Units, b: Units): Units {
  if (typeof a === 'number' && typeof b === 'number') {
    let x = a;
    let y = b;
    while (y !== 0) [x, y] = [y, x % y];
    return x;
  }
  let x = BigInt(a);
  let y = BigInt(b);
  while (y !== 0n) [x, y] = [y, x % y];
  return canon(x);
}

/** `a / b` for a `b` known to divide `a` exactly. */
export function divExact(a: Units, b: Units): Units {
  if (typeof a === 'number' && typeof b === 'number') return a / b + 0;
  return canon(BigInt(a) / BigInt(b));
}
