import { ResourceLimitError } from '../errors.js';

/**
 * Resource limits, not precision limits. They stop an untrusted string like
 * `"1e999999999"` from allocating gigabytes before any arithmetic happens.
 */
export const MAX_DIGITS = 10_000;
export const MAX_SCALE = 10_000;
/**
 * The largest bigint any operation here builds, in decimal digits, on every runtime.
 * Hermes V1 (React Native) throws `RangeError: Maximum BigInt size exceeded` past about
 * 65,400 bits (about 19,690 digits), measured 2026-10-30 on 250829098.0.17. 18,000 digits
 * is 59,794 bits: an 8.5% margin under that ceiling. It bounds plain `bigint` results
 * (`factorial`, `combinations`, `permutations`, `lcm`) and every intermediate of
 * Decimal and Rational arithmetic, which keep at most `MAX_DIGITS` digits per value.
 */
export const MAX_INTEGER_DIGITS = 18_000;
/** The same ceiling in bits: any bigint, and any shift amount, stays under this. */
export const MAX_INTEGER_BITS = 60_000;

/**
 * Throws `ResourceLimitError` when a bigint about to be built would pass `MAX_INTEGER_DIGITS`.
 * Call it with an estimate, before the multiplication or power that would build the bigint.
 */
export function assertIntermediateDigits(digits: number, what: string): void {
  if (digits > MAX_INTEGER_DIGITS) {
    throw new ResourceLimitError(`${what} needs a ${digits}-digit intermediate; the limit is ${MAX_INTEGER_DIGITS}`);
  }
}

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
