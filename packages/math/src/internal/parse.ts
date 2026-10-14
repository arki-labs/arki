import { NumberFormatError, NumericRangeError } from '../errors.js';
import { digitCount, pow10 } from './bigint.js';
import { assertDigitLimit, assertScaleLimit } from './limits.js';

/** A finite decimal as `coefficient × 10^-scale`, scale ≥ 0. */
export type DecimalParts = {
  coefficient: bigint;
  scale: number;
};

const EXPONENT_SYNTAX = /^[+-]?\d+$/;

/** Digits a JS number holds exactly (every 15-digit integer is below 2^53). */
const EXACT_NUMBER_DIGITS = 15;

function isDigit(code: number | undefined): boolean {
  return code !== undefined && code >= 48 && code <= 57;
}

/** The value of the ASCII digit at `index` (the caller has checked it is one). */
function digitAt(input: string, index: number): number {
  return (input.codePointAt(index) ?? 48) - 48;
}

function notADecimal(input: string): NumberFormatError {
  return new NumberFormatError(`"${input}" is not a decimal number`);
}

/**
 * Strict ASCII decimal syntax: optional sign, digits, optional fraction,
 * optional exponent. No whitespace, grouping, localized separators, hex,
 * `Infinity` or `NaN` — those belong to `@arki/math/parse`.
 */
export function parseDecimalString(input: string): DecimalParts {
  // One scan over the characters: [sign] digits [. digits] [e|E [sign] digits].
  const length = input.length;
  let index = 0;
  const first = input.codePointAt(0);
  if (first === 43 /* + */ || first === 45 /* - */) index = 1;
  const integerStart = index;
  while (index < length && isDigit(input.codePointAt(index))) index++;
  const integerEnd = index;
  let fractionStart = index;
  let fractionEnd = index;
  if (index < length && input.codePointAt(index) === 46 /* . */) {
    fractionStart = ++index;
    while (index < length && isDigit(input.codePointAt(index))) index++;
    fractionEnd = index;
  }
  const integerDigits = integerEnd - integerStart;
  const fractionDigits = fractionEnd - fractionStart;
  let exponent = 0;
  if (index < length) {
    const marker = input.codePointAt(index);
    const exponentText = input.slice(index + 1);
    const isExponentMarker = marker === 101 /* e */ || marker === 69; /* E */
    if (!isExponentMarker || !EXPONENT_SYNTAX.test(exponentText)) {
      throw notADecimal(input);
    }
    if (integerDigits + fractionDigits === 0) throw notADecimal(input);
    exponent = Number(exponentText);
    assertScaleLimit(exponent, 'Exponent');
  } else if (integerDigits + fractionDigits === 0) {
    throw notADecimal(input);
  }
  // Leading zeros carry no value. Only the coefficient's digits count, the rule every
  // result obeys, so a scale-10 000 value below 1 parses back from its own toString().
  let integerFrom = integerStart;
  while (integerFrom < integerEnd && input.codePointAt(integerFrom) === 48 /* 0 */) integerFrom++;
  let fractionFrom = fractionStart;
  if (integerFrom === integerEnd) {
    while (fractionFrom < fractionEnd && input.codePointAt(fractionFrom) === 48 /* 0 */) fractionFrom++;
  }
  const significantDigits = integerEnd - integerFrom + (fractionEnd - fractionFrom);
  // A positive exponent beyond the fraction digits pads a non-zero coefficient with zeros; count those too.
  const paddedDigits = significantDigits === 0 ? 0 : Math.max(0, exponent - fractionDigits);
  assertDigitLimit(significantDigits + paddedDigits, `"${input.slice(0, 20)}…"`);
  let scale = fractionDigits - exponent;
  assertScaleLimit(scale, 'Scale');

  let coefficient: bigint;
  if (significantDigits <= EXACT_NUMBER_DIGITS) {
    // Short coefficients are built exactly as a number: much cheaper than BigInt(text).
    let digits = 0;
    for (let i = integerFrom; i < integerEnd; i++) digits = digits * 10 + digitAt(input, i);
    for (let i = fractionFrom; i < fractionEnd; i++) digits = digits * 10 + digitAt(input, i);
    coefficient = BigInt(digits);
  } else {
    coefficient = BigInt(input.slice(integerFrom, integerEnd) + input.slice(fractionFrom, fractionEnd));
  }
  if (first === 45) coefficient = -coefficient;
  if (scale < 0) {
    coefficient *= pow10(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

/**
 * A JS number is read through its shortest decimal spelling, so
 * `0.1` means exactly 1/10 — what the developer wrote, not the binary
 * approximation. It cannot undo earlier float arithmetic: `0.1 + 0.2` is
 * already `0.30000000000000004` by the time it gets here.
 */
export function partsFromNumber(value: number): DecimalParts {
  if (!Number.isFinite(value)) throw new NumericRangeError(`${value} is not a finite number`);
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new NumericRangeError(
      `${value} is not a safe integer; its digits are already lost. Pass a string or bigint instead`,
    );
  }
  return parseDecimalString(value === 0 ? '0' : String(value));
}

export function partsFromBigInt(value: bigint): DecimalParts {
  assertDigitLimit(digitCount(value), 'bigint input');
  return { coefficient: value, scale: 0 };
}
