/**
 * Integer n-th roots for `decimal-math` and `finance`. Shared here so a caller that
 * adds its own guard digits (finance's `nominalRate`) can take a root without
 * building it as a Decimal: guard digits are exact intermediates, not results,
 * and do not count against the 10 000-digit result cap.
 */

import { ResourceLimitError } from '../errors.js';
import { digitCount, pow10 } from './bigint.js';

/** Largest integer a root is taken of, in digits. */
const MAX_RADICAND_DIGITS = 200_000;

function bitLength(n: bigint): number {
  return n.toString(2).length;
}

/** ⌊value^(1/k)⌋ for value ≥ 0, by Newton's iteration from a float seed above the root. */
export function integerRoot(value: bigint, k: number): bigint {
  if (value < 2n || k === 1) return value;
  const bits = bitLength(value);
  if (k >= bits) return 1n;
  const shift = Math.max(0, bits - 53);
  const rootLog2 = (Math.log2(Number(value >> BigInt(shift))) + shift) / k;
  const exponent = Math.max(0, Math.floor(rootLog2) - 50);
  let x = (BigInt(Math.ceil(2 ** (rootLog2 - exponent) * (1 + 1e-9))) + 1n) << BigInt(exponent);
  const K = BigInt(k);
  for (;;) {
    const next = ((K - 1n) * x + value / x ** (K - 1n)) / K;
    if (next >= x) break;
    x = next;
  }
  while (x ** K > value) x--;
  while ((x + 1n) ** K <= value) x++;
  return x;
}

export function assertRadicandSize(digits: number): void {
  if (digits > MAX_RADICAND_DIGITS) {
    throw new ResourceLimitError(`The root needs a ${digits}-digit intermediate; the limit is ${MAX_RADICAND_DIGITS}`);
  }
}

/**
 * ⌊x^(1/n) × 10^precision⌋ for x = magnitude × 10^-scale ≥ 0, and whether that
 * truncation is the exact root. Fixed point: the bigint stands for root × 10^-precision.
 */
export function rootAt(
  magnitude: bigint,
  scale: number,
  n: number,
  precision: number,
): { root: bigint; exact: boolean } {
  // The radicand must be an integer: work at a precision that clears the scale, then cut back.
  const working = Math.max(precision, Math.ceil(scale / n));
  const shift = n * working - scale;
  assertRadicandSize(digitCount(magnitude) + shift);
  const radicand = magnitude * pow10(shift);
  const root = integerRoot(radicand, n);
  const exact = root ** BigInt(n) === radicand;
  if (working === precision) return { root, exact };
  const unit = pow10(working - precision);
  return { root: root / unit, exact: exact && root % unit === 0n };
}
