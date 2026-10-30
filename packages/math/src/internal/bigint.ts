import type { RoundingMode } from '../rounding.js';
import { DivisionByZeroError, RoundingNecessaryError } from '../errors.js';
import { assertIntermediateDigits } from './limits.js';

export function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export function sign(n: bigint): -1 | 0 | 1 {
  return n < 0n ? -1 : n > 0n ? 1 : 0;
}

const POW10 = [1n];

/** Powers up to this exponent are memoized (≈130 KB total); larger ones are computed on demand. */
const POW10_CACHE_LIMIT = 512;

export function pow10(exponent: number): bigint {
  if (exponent > POW10_CACHE_LIMIT) return 10n ** BigInt(exponent);
  for (let i = POW10.length; i <= exponent; i++) POW10.push(POW10[i - 1]! * 10n);
  return POW10[exponent]!;
}

/** Number of decimal digits in |n|; zero has one digit. */
export function digitCount(n: bigint): number {
  return abs(n).toString().length;
}

/** About 4,214 digits: two values below it multiply to under 8,500, so they need no digit count. */
const SMALL_LIMIT = 1n << 14_000n;

function isSmall(n: bigint): boolean {
  return n < SMALL_LIMIT && n > -SMALL_LIMIT;
}

/**
 * `a × b`, refused with `ResourceLimitError` before it is built when the operand digits add up
 * past `MAX_INTEGER_DIGITS` (Hermes allocates by operand size, so it fails even for a small result).
 */
export function multiplyChecked(a: bigint, b: bigint, what: string): bigint {
  if (!isSmall(a) || !isSmall(b)) assertIntermediateDigits(digitCount(a) + digitCount(b), what);
  return a * b;
}

/** `value × 10^exponent` (exponent ≥ 0), refused before it is built when it would pass `MAX_INTEGER_DIGITS`. */
export function timesPow10(value: bigint, exponent: number, what: string): bigint {
  if (exponent > 8000 || !isSmall(value)) assertIntermediateDigits(digitCount(value) + exponent, what);
  return value * pow10(exponent);
}

export function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** Floor division (toward −∞), like Python's `//`. */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** Splits `n` into `[rest, count]` where `n = rest * factor^count`. */
export function stripFactor(n: bigint, factor: bigint): [rest: bigint, count: number] {
  let count = 0;
  while (n !== 0n && n % factor === 0n) {
    n /= factor;
    count++;
  }
  return [n, count];
}

/**
 * The one place rounding happens. Returns `numerator / denominator` as an
 * integer, rounded with `mode`. Every rounding helper in the package reduces
 * its problem to this call.
 */
export function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new DivisionByZeroError('Division by zero');
  const resultSign = sign(numerator) * sign(denominator);
  const n = abs(numerator);
  const d = abs(denominator);
  const quotient = n / d;
  const remainder = n % d;
  if (remainder === 0n) return resultSign < 0 ? -quotient : quotient;

  const half = sign(remainder * 2n - d); // -1 below half, 0 exactly half, 1 above half
  let roundUp: boolean;
  switch (mode) {
    case 'unnecessary': {
      throw new RoundingNecessaryError(
        'The exact result has more digits than requested; pass a rounding mode such as "halfEven"',
      );
    }
    case 'down': {
      roundUp = false;
      break;
    }
    case 'up': {
      roundUp = true;
      break;
    }
    case 'ceiling': {
      roundUp = resultSign > 0;
      break;
    }
    case 'floor': {
      roundUp = resultSign < 0;
      break;
    }
    case 'halfUp': {
      roundUp = half >= 0;
      break;
    }
    case 'halfDown': {
      roundUp = half > 0;
      break;
    }
    case 'halfEven': {
      roundUp = half > 0 || (half === 0 && quotient % 2n === 1n);
      break;
    }
  }
  const magnitude = roundUp ? quotient + 1n : quotient;
  return resultSign < 0 ? -magnitude : magnitude;
}
