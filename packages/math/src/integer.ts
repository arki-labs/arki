/**
 * Integer helpers with matching `number` and `bigint` overloads. Both
 * arguments must share a type; the `number` forms require safe integers and
 * refuse to return an unsafe one.
 */

import { DivisionByZeroError, InvalidArgumentError, NumericRangeError } from './errors.js';
import { floorDiv, gcd as gcdBigInt } from './internal/bigint.js';

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new InvalidArgumentError(`${name} must be a safe integer, got ${value}`);
  }
}

function assertSameKind(a: number | bigint, b: number | bigint): void {
  if (typeof a !== typeof b) {
    throw new TypeError(`Cannot mix ${typeof a} and ${typeof b}; convert one side first`);
  }
}

/** Greatest common divisor, always non-negative. `gcd(0, 0)` is `0`. */
export function gcd(a: number, b: number): number;
export function gcd(a: bigint, b: bigint): bigint;
export function gcd(a: number | bigint, b: number | bigint): number | bigint {
  assertSameKind(a, b);
  if (typeof a === 'bigint') return gcdBigInt(a, b as bigint);
  assertSafeInteger(a, 'a');
  assertSafeInteger(b as number, 'b');
  let x = Math.abs(a);
  let y = Math.abs(b as number);
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

/** Least common multiple, always non-negative. Zero in → zero out. */
export function lcm(a: number, b: number): number;
export function lcm(a: bigint, b: bigint): bigint;
export function lcm(a: number | bigint, b: number | bigint): number | bigint {
  assertSameKind(a, b);
  if (typeof a === 'bigint') {
    const bb = b as bigint;
    if (a === 0n || bb === 0n) return 0n;
    const product = (a / gcdBigInt(a, bb)) * bb;
    return product < 0n ? -product : product;
  }
  const bn = b as number;
  if (a === 0 || bn === 0) return gcd(a, bn) * 0; // validates inputs, returns 0
  const result = Math.abs((a / gcd(a, bn)) * bn);
  if (!Number.isSafeInteger(result)) {
    throw new NumericRangeError(`lcm(${a}, ${bn}) exceeds Number.MAX_SAFE_INTEGER; use bigint`);
  }
  return result;
}

/**
 * Floor division and remainder, like Python's `divmod`: the quotient rounds
 * toward −∞ and the remainder takes the sign of the divisor, so
 * `divmod(-7, 2)` is `[-4, 1]` and `divmod(7, -2)` is `[-4, -1]`.
 */
export function divmod(a: number, b: number): [quotient: number, remainder: number];
export function divmod(a: bigint, b: bigint): [quotient: bigint, remainder: bigint];
export function divmod(
  a: number | bigint,
  b: number | bigint,
): [quotient: number | bigint, remainder: number | bigint] {
  assertSameKind(a, b);
  if (typeof a === 'bigint') {
    const bb = b as bigint;
    if (bb === 0n) throw new DivisionByZeroError('Division by zero');
    const quotient = floorDiv(a, bb);
    return [quotient, a - quotient * bb];
  }
  const bn = b as number;
  assertSafeInteger(a, 'a');
  assertSafeInteger(bn, 'b');
  if (bn === 0) throw new DivisionByZeroError('Division by zero');
  const quotient = Math.floor(a / bn);
  const remainder = a - quotient * bn;
  return [quotient === 0 ? 0 : quotient, remainder === 0 ? 0 : remainder];
}
