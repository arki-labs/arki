import { NumberFormatError, NumericRangeError } from '../errors.js';
import { pow10 } from './bigint.js';
import { assertDigitLimit, assertScaleLimit } from './limits.js';

/** A finite decimal as `coefficient × 10^-scale`, scale ≥ 0. */
export type DecimalParts = {
  coefficient: bigint;
  scale: number;
};

const DECIMAL_SYNTAX = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;

/**
 * Strict ASCII decimal syntax: optional sign, digits, optional fraction,
 * optional exponent. No whitespace, grouping, localized separators, hex,
 * `Infinity` or `NaN` — those belong to `@arki/math/parse`.
 */
export function parseDecimalString(input: string): DecimalParts {
  const match = DECIMAL_SYNTAX.exec(input);
  const integerDigits = match?.[2] ?? '';
  const fractionDigits = match?.[3] ?? '';
  if (!match || (integerDigits === '' && fractionDigits === '')) {
    throw new NumberFormatError(`"${input}" is not a decimal number`);
  }
  const exponentText = match[4];
  if (exponentText !== undefined) assertScaleLimit(Number(exponentText), 'Exponent');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  assertDigitLimit(integerDigits.length + fractionDigits.length, `"${input.slice(0, 20)}…"`);

  let coefficient = BigInt(integerDigits + fractionDigits || '0');
  if (match[1] === '-') coefficient = -coefficient;
  let scale = fractionDigits.length - exponent;
  if (scale < 0) {
    coefficient *= pow10(-scale);
    scale = 0;
  }
  assertScaleLimit(scale, 'Scale');
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
  return { coefficient: value, scale: 0 };
}
