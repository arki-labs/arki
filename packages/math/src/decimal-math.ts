/**
 * Roots, logarithms, exponentials and the constants π and e on `Decimal`,
 * to any number of fraction digits up to the package limits.
 *
 * Every result is *correctly rounded*: the returned digits are exactly what
 * you get by rounding the true mathematical value to `scale` fraction digits
 * with the chosen mode. How:
 *
 * - Roots use integer Newton iteration on the scaled coefficient. The integer
 *   root is exact, so one extra "sticky" digit tells whether anything was cut
 *   off, and rounding is exact with no guessing.
 * - Everything else is computed in bigint fixed point with at least
 *   `scale + 10` fraction digits (plus internal headroom for the size of the
 *   result and the error each step adds), so the approximation is within
 *   2 units of its last digit. If rounding both ends of that interval gives
 *   the same answer, that answer is correct. If not, the true value sits
 *   within a hair of a rounding boundary: the guard digits double and the
 *   value is recomputed (Ziv's strategy), up to 2560 guard digits.
 * - Results that can be exact (`ln(1)`, `exp(0)`, `log(8, 2)`, `pow(4, '0.5')`)
 *   are detected exactly, so `rounding: 'unnecessary'` returns them and
 *   throws `RoundingNecessaryError` for everything else.
 *
 * Practical limits: `scale` is at most 10 000, and a result may have at most
 * 10 000 digits in total (`exp(100000, { scale: 10 })` throws
 * `ResourceLimitError`). Cost grows faster than linearly with `scale`: about
 * a millisecond at 50 digits, about 10 ms at 1 000, and a few seconds for a
 * logarithm at 10 000.
 */

import type { DecimalInput } from './decimal.js';
import type { RoundingMode } from './rounding.js';
import { Decimal } from './decimal.js';
import { DivisionByZeroError, InvalidArgumentError, ResourceLimitError, RoundingNecessaryError } from './errors.js';
import { abs, digitCount, divideRounded, gcd, pow10 } from './internal/bigint.js';
import { assertScale } from './internal/fraction.js';
import { MAX_DIGITS } from './internal/limits.js';

/**
 * Number of fraction digits in the result and how to round the last one.
 * Transcendental results are never exact, so rounding defaults to
 * `'halfEven'` here (unlike Decimal's own `'unnecessary'`).
 */
export type PrecisionOptions = { scale: number; rounding?: RoundingMode };

type Resolved = { scale: number; rounding: RoundingMode };

/** Guard digits on the first attempt. */
const GUARD_DIGITS = 10;
/** Ziv's loop gives up after this many guard digits. */
const MAX_GUARD_DIGITS = 2560;
/** Every fixed-point approximation is within this many units of its last digit. */
const ERROR_BOUND = 2n;
/** Largest integer a root is taken of, in digits. */
const MAX_RADICAND_DIGITS = 200_000;
/** Largest power built while checking whether a logarithm is exact, in digits. */
const MAX_EXACT_CHECK_DIGITS = 4 * MAX_DIGITS;

const ONE = Decimal.from(1);

function zeroAt(scale: number): Decimal {
  return Decimal.fromParts({ coefficient: 0n, scale });
}

function resolve(options: PrecisionOptions | undefined, name: string): Resolved {
  if (options === undefined) {
    throw new InvalidArgumentError(`${name} has no exact result; pass { scale } (and optionally rounding)`);
  }
  assertScale(options.scale);
  return { scale: options.scale, rounding: options.rounding ?? 'halfEven' };
}

function inexact(): RoundingNecessaryError {
  return new RoundingNecessaryError(
    'The exact result has infinitely many digits; pass a rounding mode such as "halfEven"',
  );
}

// ---------------------------------------------------------------------------
// Float estimates (only used to size the work, never for result digits)
// ---------------------------------------------------------------------------

/** `|coefficient| × 10^-scale` as a float; may be 0 or Infinity at the extremes. */
function approximate(value: Decimal): number {
  const digits = abs(value.coefficient).toString();
  const lead = digits.slice(0, 17);
  const magnitude = Number(`${lead}e${digits.length - lead.length - value.scale}`);
  return value.coefficient < 0n ? -magnitude : magnitude;
}

/** log10 of a positive decimal as a float, without overflow. */
function log10Estimate(value: Decimal): number {
  const digits = value.coefficient.toString();
  return Math.log10(Number(`0.${digits.slice(0, 17)}`)) + digits.length - value.scale;
}

/** A positive value below 1% of the last kept digit, rounded with `rounding`. */
function belowHalfUnit(scale: number, rounding: RoundingMode): Decimal {
  return Decimal.fromParts({ coefficient: divideRounded(1n, 100n, rounding), scale });
}

// ---------------------------------------------------------------------------
// Ziv's loop
// ---------------------------------------------------------------------------

/**
 * Rounds a value known only through `approximateAt(precision)`, which must
 * return `A` with |value × 10^precision − A| < 2. `isExact` checks whether a
 * candidate decimal is the exact value; without it the value is known to be
 * irrational.
 */
function roundApproximation(
  approximateAt: (precision: number) => bigint,
  { scale, rounding }: Resolved,
  isExact?: (candidate: Decimal) => boolean,
): Decimal {
  if (rounding === 'unnecessary' && !isExact) throw inexact();
  const probe: RoundingMode = rounding === 'unnecessary' ? 'down' : rounding;
  for (let guard = GUARD_DIGITS; guard <= MAX_GUARD_DIGITS; guard *= 2) {
    const approximation = approximateAt(scale + guard);
    const unit = pow10(guard);
    const low = divideRounded(approximation - ERROR_BOUND, unit, probe);
    const high = divideRounded(approximation + ERROR_BOUND, unit, probe);
    if (low === high) {
      if (rounding === 'unnecessary') throw inexact();
      return Decimal.fromParts({ coefficient: low, scale });
    }
    if (isExact) {
      // A boundary is a decimal with at most scale + 1 digits; if the value is
      // exact it is the nearest such decimal to the approximation.
      const coefficient = divideRounded(approximation, pow10(guard - 1), 'halfEven');
      const candidate = Decimal.fromParts({ coefficient, scale: scale + 1 });
      if (isExact(candidate)) return candidate.toScale(scale, rounding);
    }
  }
  throw new ResourceLimitError(
    `Could not decide the rounding of the last digit within ${MAX_GUARD_DIGITS} guard digits`,
  );
}

// ---------------------------------------------------------------------------
// Integer roots
// ---------------------------------------------------------------------------

function bitLength(n: bigint): number {
  return n.toString(2).length;
}

/** ⌊value^(1/k)⌋ for value ≥ 0, by Newton's iteration from a float seed above the root. */
function integerRoot(value: bigint, k: number): bigint {
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

function assertRadicandSize(digits: number): void {
  if (digits > MAX_RADICAND_DIGITS) {
    throw new ResourceLimitError(`The root needs a ${digits}-digit intermediate; the limit is ${MAX_RADICAND_DIGITS}`);
  }
}

/** The exact n-th root as a decimal, or `undefined` when it has infinitely many digits. */
function exactRoot(x: Decimal, n: number): Decimal | undefined {
  const magnitude = abs(x.coefficient);
  const paddedScale = Math.ceil(x.scale / n) * n;
  assertRadicandSize(digitCount(magnitude) + paddedScale - x.scale);
  const radicand = magnitude * pow10(paddedScale - x.scale);
  const root = integerRoot(radicand, n);
  if (root ** BigInt(n) !== radicand) return undefined;
  return Decimal.fromParts({ coefficient: x.coefficient < 0n ? -root : root, scale: paddedScale / n });
}

function rootOf(value: DecimalInput, n: number, options: PrecisionOptions | undefined, name: string): Decimal {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new InvalidArgumentError(`The root degree must be a positive safe integer, got ${n}`);
  }
  const x = Decimal.from(value);
  if (x.isNegative() && n % 2 === 0) {
    throw new InvalidArgumentError(`${name} of a negative number (${x.toString()}) is not real`);
  }
  if (options === undefined) {
    const root = exactRoot(x, n);
    if (!root) {
      throw new RoundingNecessaryError(
        `${name}(${x.toString()}) has infinitely many digits; pass { scale } to round it`,
      );
    }
    return root;
  }
  const { scale, rounding } = resolve(options, name);
  const magnitude = abs(x.coefficient);
  // One digit past `scale`, so a "sticky" digit can stand in for everything cut off.
  const working = Math.max(scale + 1, Math.ceil(x.scale / n));
  const shift = n * working - x.scale;
  assertRadicandSize(digitCount(magnitude) + shift);
  const radicand = magnitude * pow10(shift);
  const root = integerRoot(radicand, n);
  const sticky = root ** BigInt(n) === radicand ? 0n : 1n;
  const tenfold = root * 10n + sticky;
  const coefficient = divideRounded(x.isNegative() ? -tenfold : tenfold, pow10(working + 1 - scale), rounding);
  return Decimal.fromParts({ coefficient, scale });
}

// ---------------------------------------------------------------------------
// Fixed-point kernels: bigint V stands for V × 10^-precision
// ---------------------------------------------------------------------------

type FixedCache = { digits: number; value: bigint };

/**
 * Serves a constant at `precision` from the most precise copy computed so
 * far; recomputes (with 10+ hidden guard digits) only when asked for more.
 */
function cachedConstant(cache: FixedCache, precision: number, compute: (precision: number) => bigint): bigint {
  if (cache.digits < precision) {
    const digits = Math.max(precision, Math.ceil(cache.digits * 1.5));
    const guard = 10 + String(digits).length;
    cache.value = compute(digits + guard) / pow10(guard);
    cache.digits = digits;
  }
  return cache.value / pow10(cache.digits - precision);
}

/** atanh(1/n) × one. */
function atanhInverse(n: bigint, one: bigint): bigint {
  const n2 = n * n;
  let power = one / n;
  let sum = power;
  for (let k = 3n; ; k += 2n) {
    power /= n2;
    if (power === 0n) return sum;
    sum += power / k;
  }
}

/** atan(1/n) × one. */
function atanInverse(n: bigint, one: bigint): bigint {
  const n2 = n * n;
  let power = one / n;
  let sum = power;
  let add = false;
  for (let k = 3n; ; k += 2n) {
    power /= n2;
    if (power === 0n) return sum;
    sum = add ? sum + power / k : sum - power / k;
    add = !add;
  }
}

const PI_CACHE: FixedCache = { digits: -1, value: 0n };
const E_CACHE: FixedCache = { digits: -1, value: 0n };
const LN2_CACHE: FixedCache = { digits: -1, value: 0n };
const LN10_CACHE: FixedCache = { digits: -1, value: 0n };

/** Machin: π = 16·atan(1/5) − 4·atan(1/239). */
function piFixed(precision: number): bigint {
  return cachedConstant(PI_CACHE, precision, digits => {
    const one = pow10(digits);
    return 16n * atanInverse(5n, one) - 4n * atanInverse(239n, one);
  });
}

/** e = Σ 1/k!. */
function eFixed(precision: number): bigint {
  return cachedConstant(E_CACHE, precision, digits => {
    const one = pow10(digits);
    let term = one;
    let sum = one;
    for (let k = 1n; term !== 0n; k++) {
      term /= k;
      sum += term;
    }
    return sum;
  });
}

/** ln 2 = 18·atanh(1/26) − 2·atanh(1/4801) + 8·atanh(1/8749). */
function ln2Fixed(precision: number): bigint {
  return cachedConstant(LN2_CACHE, precision, digits => {
    const one = pow10(digits);
    return 18n * atanhInverse(26n, one) - 2n * atanhInverse(4801n, one) + 8n * atanhInverse(8749n, one);
  });
}

/** ln 10 = 3·ln 2 + ln(5/4), and ln(5/4) = 2·atanh(1/9). */
function ln10Fixed(precision: number): bigint {
  return cachedConstant(LN10_CACHE, precision, digits => 3n * ln2Fixed(digits) + 2n * atanhInverse(9n, pow10(digits)));
}

/** Decimal exponent k with x = m × 10^k, m in [1, 10). */
function decimalExponent(x: Decimal): number {
  return digitCount(x.coefficient) - 1 - x.scale;
}

/**
 * ln(x) for x > 0, within 1 unit at `precision`. x = m·10^k, m = 2^j·r with
 * r in [0.75, 1.5), and ln r = 2·atanh((r − 1)/(r + 1)).
 */
function lnFixed(x: Decimal, precision: number): bigint {
  const digits = digitCount(x.coefficient);
  const exponent = decimalExponent(x);
  // Headroom for the series' rounding errors and for |k| × the error of ln 10.
  const extra = 10 + digitCount(BigInt(Math.abs(exponent) + 1)) + String(precision).length;
  const q = precision + extra;
  const one = pow10(q);
  const shift = q - (digits - 1);
  const m = shift >= 0 ? x.coefficient * pow10(shift) : x.coefficient / pow10(-shift);
  const twos = m < (one * 3n) / 2n ? 0 : m < one * 3n ? 1 : m < one * 6n ? 2 : 3;
  const r = m >> BigInt(twos);
  const z = ((r - one) * one) / (r + one);
  const z2 = (z * z) / one;
  let term = z;
  let sum = z;
  for (let k = 3n; ; k += 2n) {
    term = (term * z2) / one;
    if (term === 0n) break;
    sum += term / k;
  }
  let result = 2n * sum;
  if (twos !== 0) result += BigInt(twos) * ln2Fixed(q);
  if (exponent !== 0) result += BigInt(exponent) * ln10Fixed(q);
  return result / pow10(extra);
}

/** Digits d with |ln x| ≤ 10^d (since |ln x| ≤ 2.31·(|k| + 1)). */
function lnMagnitudeDigits(x: Decimal): number {
  return digitCount(BigInt(Math.abs(decimalExponent(x)) + 1)) + 1;
}

/** Digits d with |ln b| ≥ 10^-d, for b ≠ 1 (|ln(1 + t)| ≥ |t|/1.1 when |t| < 0.1). */
function lnSmallnessDigits(b: Decimal): number {
  const t = b.minus(ONE);
  if (t.abs().gte('0.1')) return 2;
  return 1 - decimalExponent(t);
}

/** log_b(x) within 1.01 units at `precision`. */
function logFixed(x: Decimal, b: Decimal, precision: number): bigint {
  const q = precision + lnMagnitudeDigits(x) + 2 * lnSmallnessDigits(b) + 3;
  return (lnFixed(x, q) * pow10(precision)) / lnFixed(b, q);
}

/**
 * e^v for v = coefficient × 10^-scale, within 1 unit at `precision`, assuming
 * the result fits (callers check). Reduces v by 2^h, sums the Taylor series,
 * squares back h times; negative v is computed as 1 / e^|v|.
 */
function expFixed(coefficient: bigint, scale: number, precision: number): bigint {
  if (coefficient === 0n) return pow10(precision);
  const negative = coefficient < 0n;
  const magnitude = abs(coefficient);
  const estimate = Math.abs(approximate(Decimal.fromParts({ coefficient: magnitude, scale })));
  const integerDigits = negative ? 0 : Math.ceil(estimate * Math.LOG10E) + 1;
  const integerBits = estimate >= 1 ? Math.floor(Math.log2(estimate)) + 1 : 0;
  const halvings = integerBits + Math.max(4, Math.ceil(1.8 * Math.sqrt(precision)));
  // Squaring h times multiplies the relative error by 2^h.
  const guard = 8 + Math.ceil(halvings * 0.302) + String(precision).length;
  const q = precision + integerDigits + guard;
  const one = pow10(q);
  const y = (magnitude * one) / (pow10(scale) << BigInt(halvings));
  let term = y;
  let sum = one + y;
  for (let k = 2n; ; k++) {
    term = (term * y) / (one * k);
    if (term === 0n) break;
    sum += term;
  }
  for (let i = 0; i < halvings; i++) sum = (sum * sum) / one;
  return negative ? pow10(q + precision) / sum : sum / pow10(q - precision);
}

/**
 * Checks log_b(x) = candidate exactly: with candidate = p/q in lowest terms,
 * that is x^q = b^p. Gives up (returns false) when the powers would be huge.
 */
function isExactLogarithm(x: Decimal, b: Decimal, candidate: Decimal): boolean {
  const divisor = gcd(candidate.coefficient, pow10(candidate.scale));
  const p = candidate.coefficient / divisor;
  const q = pow10(candidate.scale) / divisor;
  const xDigits = digitCount(x.coefficient) + x.scale;
  const bDigits = digitCount(b.coefficient) + b.scale;
  if (Number(q) * xDigits > MAX_EXACT_CHECK_DIGITS || Number(abs(p)) * bDigits > MAX_EXACT_CHECK_DIGITS) {
    return false;
  }
  const xPower = x.coefficient ** q;
  const xScale = x.scale * Number(q);
  const bPower = b.coefficient ** abs(p);
  const bScale = b.scale * Number(abs(p));
  // x^q = b^p  ⇔  cx^q · 10^(sb·p) = cb^p · 10^(sx·q)   (p ≥ 0)
  //            ⇔  cx^q · cb^|p| = 10^(sx·q + sb·|p|)   (p < 0)
  return p >= 0n ? xPower * pow10(bScale) === bPower * pow10(xScale) : xPower * bPower === pow10(xScale + bScale);
}

function assertResultDigits(integerDigits: number, scale: number, what: string): void {
  if (Number.isNaN(integerDigits) || integerDigits + scale > MAX_DIGITS) {
    throw new ResourceLimitError(`${what} would have more than ${MAX_DIGITS} digits`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Square root. Without options the result must be exact or it throws
 * `RoundingNecessaryError`: `sqrt(16)` → `4`, `sqrt('2.25')` → `1.5`,
 * `sqrt(2)` throws. The exact result of a value with scale s has scale s/2,
 * after padding an odd s with one zero: `sqrt('1.00')` → `1.0`,
 * `sqrt('0.0001')` → `0.01`, `sqrt('0.4')` (= √0.40) throws.
 *
 * With `{ scale }`, the correctly rounded value at that scale (default
 * rounding `'halfEven'`): `sqrt(2, { scale: 3, rounding: 'floor' })` → `1.414`.
 * Negative input throws `InvalidArgumentError`.
 */
export function sqrt(value: DecimalInput, options?: PrecisionOptions): Decimal {
  return rootOf(value, 2, options, 'sqrt');
}

/**
 * Cube root; negative input gives a negative root. Same exact-or-throw rule
 * as `sqrt` (scale s padded up to a multiple of 3, then divided by 3):
 * `cbrt('-27')` → `-3`, `cbrt(2, { scale: 5 })` → `1.25992`.
 */
export function cbrt(value: DecimalInput, options?: PrecisionOptions): Decimal {
  return rootOf(value, 3, options, 'cbrt');
}

/**
 * The n-th root for a positive safe integer `n`. Same exact-or-throw rule as
 * `sqrt` (scale padded up to a multiple of n, then divided by n):
 * `nthRoot('1024', 10)` → `2`. Even roots of negative values throw
 * `InvalidArgumentError`; odd roots keep the sign. Intermediates are capped at
 * 200 000 digits (`ResourceLimitError`), which bounds `n × scale`.
 */
export function nthRoot(value: DecimalInput, n: number, options?: PrecisionOptions): Decimal {
  return rootOf(value, n, options, 'nthRoot');
}

/**
 * e^x, correctly rounded to `scale` fraction digits. `exp(0)` is exactly 1;
 * every other result is irrational, so `rounding: 'unnecessary'` throws.
 * Results with more than 10 000 digits (`scale` + integer digits; about
 * x > 23 000 at small scales) throw `ResourceLimitError`. Very negative x
 * rounds to zero (or one unit for `'up'`/`'ceiling'`).
 */
export function exp(value: DecimalInput, options: PrecisionOptions): Decimal {
  const x = Decimal.from(value);
  const resolved = resolve(options, 'exp');
  if (x.isZero()) return ONE.toScale(resolved.scale);
  const log10Result = approximate(x) * Math.LOG10E;
  assertResultDigits(Math.floor(log10Result) + 1, resolved.scale, `exp(${x.toString()})`);
  if (log10Result < -(resolved.scale + 3)) return belowHalfUnit(resolved.scale, resolved.rounding);
  return roundApproximation(precision => expFixed(x.coefficient, x.scale, precision), resolved);
}

/**
 * Natural logarithm, correctly rounded to `scale` fraction digits.
 * `ln(1)` is exactly 0; values ≤ 0 throw `InvalidArgumentError`.
 * `ln 2` and `ln 10` are computed once per precision and reused.
 */
export function ln(value: DecimalInput, options: PrecisionOptions): Decimal {
  const x = Decimal.from(value);
  const resolved = resolve(options, 'ln');
  if (!x.isPositive()) throw new InvalidArgumentError(`ln is defined for positive values, got ${x.toString()}`);
  if (x.eq(ONE)) return zeroAt(resolved.scale);
  return roundApproximation(precision => lnFixed(x, precision), resolved);
}

/**
 * Logarithm of `value` in `base` (> 0, ≠ 1), correctly rounded to `scale`
 * fraction digits. Exact results are detected — `log(8, 2)` → `3`,
 * `log(8, 4)` → `1.5` — so `rounding: 'unnecessary'` accepts them.
 */
export function log(value: DecimalInput, base: DecimalInput, options: PrecisionOptions): Decimal {
  const x = Decimal.from(value);
  const b = Decimal.from(base);
  const resolved = resolve(options, 'log');
  if (!x.isPositive()) throw new InvalidArgumentError(`log is defined for positive values, got ${x.toString()}`);
  if (!b.isPositive() || b.eq(ONE)) {
    throw new InvalidArgumentError(`The logarithm base must be positive and not 1, got ${b.toString()}`);
  }
  if (x.eq(ONE)) return zeroAt(resolved.scale);
  return roundApproximation(
    precision => logFixed(x, b, precision),
    resolved,
    candidate => isExactLogarithm(x, b, candidate),
  );
}

/** Base-10 logarithm, correctly rounded: `log10(1000, { scale: 5 })` → `3.00000`. */
export function log10(value: DecimalInput, options: PrecisionOptions): Decimal {
  return log(value, 10, options);
}

/** Base-2 logarithm, correctly rounded: `log2(1024, { scale: 5 })` → `10.00000`. */
export function log2(value: DecimalInput, options: PrecisionOptions): Decimal {
  return log(value, 2, options);
}

/**
 * `base` raised to `exponent`.
 *
 * - Integer exponent: exact, through `Decimal#pow` (`pow(2, 10)` → `1024`,
 *   `0^0` → `1`). With options the exact result is rounded to `scale`; a
 *   negative exponent then divides with rounding (`pow(3, -1, { scale: 3 })`
 *   → `0.333`) instead of throwing.
 * - Non-integer exponent: requires options (`InvalidArgumentError` otherwise)
 *   and a base ≥ 0 (`InvalidArgumentError` for negative bases); computed as
 *   exp(exponent · ln(base)) and correctly rounded. `0^positive` is 0. Exact
 *   cases are detected: `pow(4, '0.5', { scale: 2 })` → `2.00`.
 * - Results over 10 000 digits throw `ResourceLimitError`.
 */
export function pow(base: DecimalInput, exponent: DecimalInput, options?: PrecisionOptions): Decimal {
  const x = Decimal.from(base);
  const y = Decimal.from(exponent);

  if (y.isInteger()) {
    const n = Number(y.toBigInt());
    if (options === undefined) return x.pow(n);
    const { scale, rounding } = resolve(options, 'pow');
    if (n < 0 && !x.isZero()) return ONE.dividedBy(x.pow(-n), { scale, rounding });
    return x.pow(n).toScale(scale, rounding);
  }

  const resolved = resolve(options, `pow with the non-integer exponent ${y.toString()}`);
  const { scale, rounding } = resolved;
  if (x.isNegative()) {
    throw new InvalidArgumentError(`A negative base (${x.toString()}) to a non-integer power is not real`);
  }
  if (x.isZero()) {
    if (y.isNegative()) throw new DivisionByZeroError('Zero cannot be raised to a negative power');
    return zeroAt(scale);
  }
  if (x.eq(ONE)) return ONE.toScale(scale);

  // Exact when base is a perfect q-th power, exponent = p/q in lowest terms.
  // A rational r ≠ 1 with r^q = base needs at least q bits in base.
  const divisor = gcd(y.coefficient, pow10(y.scale));
  const p = y.coefficient / divisor;
  const q = pow10(y.scale) / divisor;
  const baseBits = Math.ceil((Math.max(digitCount(x.coefficient), x.scale) + 1) * 3.33);
  if (q <= BigInt(baseBits)) {
    const root = exactRoot(x, Number(q));
    if (root) {
      const power = Number(p);
      return power < 0
        ? ONE.dividedBy(root.pow(-power), { scale, rounding })
        : root.pow(power).toScale(scale, rounding);
    }
  }

  const log10Result = approximate(y) * log10Estimate(x);
  assertResultDigits(Math.floor(log10Result) + 1, scale, `pow(${x.toString()}, ${y.toString()})`);
  if (log10Result < -(scale + 3)) return belowHalfUnit(scale, rounding);
  const integerDigits = Math.max(0, Math.ceil(log10Result)) + 1;
  const exponentDigits = digitCount(abs(y.coefficient) / pow10(y.scale)) + 1;
  return roundApproximation(precision => {
    // t = y·ln(x) to `exponentPrecision` digits: an error δ in t is a relative error δ in the result.
    const exponentPrecision = precision + integerDigits + 10;
    const lnBase = lnFixed(x, exponentPrecision + exponentDigits);
    const t = (y.coefficient * lnBase) / pow10(y.scale + exponentDigits);
    return expFixed(t, exponentPrecision, precision);
  }, resolved);
}

/** π to `scale` fraction digits, rounded half-even. Machin's formula, cached per precision. */
export function PI(scale: number): Decimal {
  assertScale(scale);
  return roundApproximation(piFixed, { scale, rounding: 'halfEven' });
}

/** e to `scale` fraction digits, rounded half-even. Σ 1/k!, cached per precision. */
export function E(scale: number): Decimal {
  assertScale(scale);
  return roundApproximation(eFixed, { scale, rounding: 'halfEven' });
}
