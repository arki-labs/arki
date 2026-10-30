import { ResourceLimitError } from '../errors.js';

/**
 * Resource limits, not precision limits. They stop an untrusted string like
 * `"1e999999999"` from allocating gigabytes before any arithmetic happens.
 */
export const MAX_DIGITS = 10_000;
export const MAX_SCALE = 10_000;
/**
 * Digit cap for plain `bigint` integer results (`factorial`, `combinations`,
 * `permutations`). Decimal and Rational keep the tighter `MAX_DIGITS`: their
 * arithmetic multiplies and rescales, so size costs more there.
 */
export const MAX_INTEGER_DIGITS = 100_000;

/** True when `digitCount` passes `MAX_DIGITS`. Parsers return a failure on it; builders throw. */
export function exceedsDigitLimit(digitCount: number): boolean {
  return digitCount > MAX_DIGITS;
}

/** True when `scale` is not a safe integer within ±`MAX_SCALE`. */
export function exceedsScaleLimit(scale: number): boolean {
  return !Number.isSafeInteger(scale) || Math.abs(scale) > MAX_SCALE;
}

export function assertDigitLimit(digitCount: number, what: string): void {
  if (exceedsDigitLimit(digitCount)) {
    throw new ResourceLimitError(`${what} has ${digitCount} digits; the limit is ${MAX_DIGITS}`);
  }
}

export function assertScaleLimit(scale: number, what: string): void {
  if (exceedsScaleLimit(scale)) {
    throw new ResourceLimitError(`${what} ${scale} is outside the supported range ±${MAX_SCALE}`);
  }
}
