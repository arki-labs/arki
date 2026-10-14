/**
 * Helpers for ordinary JS numbers: the fast, approximate 80% case (UI, geometry,
 * charts). For money or anything that must be exact, use `@arki/math/decimal`.
 *
 * Every input must be finite; `NaN` and `±Infinity` throw rather than spread.
 * Results never carry `-0`.
 */

import type { Decimal } from './internal/exact.js';
import type { RoundingMode } from './rounding.js';
import { InvalidArgumentError, NumberFormatError, NumericRangeError, ResourceLimitError } from './errors.js';
import { abs, digitCount, divideRounded, pow10 } from './internal/bigint.js';
import { parseDecimalString } from './internal/parse.js';
import { roundExact, roundToExact } from './internal/round.js';

/** Interval notation: `[` / `]` include the bound, `(` / `)` exclude it. */
export type Bounds = '[]' | '[)' | '(]' | '()';

/** @internal Shared argument guard; not part of the public API. */
export function assertFinite(value: number, name: string): void {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`);
  if (!Number.isFinite(value)) throw new InvalidArgumentError(`${name} must be finite, got ${value}`);
}

function assertOrdered(min: number, max: number): void {
  assertFinite(min, 'min');
  assertFinite(max, 'max');
  if (min > max) throw new InvalidArgumentError(`min (${min}) is greater than max (${max})`);
}

function noNegativeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** Longest sequence `range` or `linspace` will build; keeps `range(0, 1e12)` from exhausting memory. */
const MAX_SEQUENCE_LENGTH = 10_000_000;

function assertSequenceLength(length: number): void {
  if (length > MAX_SEQUENCE_LENGTH) {
    throw new ResourceLimitError(`sequence of ${length} numbers exceeds the limit of ${MAX_SEQUENCE_LENGTH}`);
  }
}

/**
 * Numbers from `start` up to but excluding `end`, `step` apart (default 1):
 * `range(5)` → `[0, 1, 2, 3, 4]`, `range(0, 1, 0.25)` → `[0, 0.25, 0.5, 0.75]`.
 * A negative `step` counts down (`range(3, 0, -1)` → `[3, 2, 1]`). Each element
 * is `start + i * step`, so fractional steps do not drift. A step pointing away
 * from `end` gives `[]`. Throws `InvalidArgumentError` for a zero or non-finite
 * step and `ResourceLimitError` past 10,000,000 elements.
 */
export function range(end: number): number[];
export function range(start: number, end: number, step?: number): number[];
export function range(first: number, second?: number, step = 1): number[] {
  const start = second === undefined ? 0 : first;
  const end = second === undefined ? first : second;
  assertFinite(start, 'start');
  assertFinite(end, 'end');
  assertFinite(step, 'step');
  if (step === 0) throw new InvalidArgumentError('step must be non-zero');
  let length = Math.max(0, Math.ceil((end - start) / step));
  if (!Number.isFinite(length)) throw new ResourceLimitError('sequence is too long to build');
  // The quotient can round up past a whole count (0.3 / 0.1 → 3.0000000000000004), which would add an element at `end`.
  if (length > 0) {
    const last = start + (length - 1) * step;
    if (step > 0 ? last >= end : last <= end) length--;
  }
  assertSequenceLength(length);
  const out: number[] = [];
  for (let i = 0; i < length; i++) out.push(noNegativeZero(start + i * step));
  return out;
}

/**
 * `count` evenly spaced numbers from `start` to `end`, both included:
 * `linspace(0, 1, 5)` → `[0, 0.25, 0.5, 0.75, 1]`. `count` 1 gives `[start]`,
 * 0 gives `[]`. The first element is exactly `start` and the last exactly `end`;
 * the span may exceed the float range (`linspace(-1e308, 1e308, 3)` works). Throws `InvalidArgumentError`
 * unless `count` is a non-negative safe integer and `ResourceLimitError` past
 * 10,000,000 elements.
 */
export function linspace(start: number, end: number, count: number): number[] {
  assertFinite(start, 'start');
  assertFinite(end, 'end');
  assertFinite(count, 'count');
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new InvalidArgumentError(`count must be a non-negative safe integer, got ${count}`);
  }
  assertSequenceLength(count);
  if (count === 0) return [];
  if (count === 1) return [noNegativeZero(start)];
  const last = count - 1;
  const out: number[] = [noNegativeZero(start)];
  // Weighted form, not `start + (end - start) * t`: the span can overflow (-1e308 to 1e308) where the weights cannot.
  for (let i = 1; i < last; i++) {
    const t = i / last;
    out.push(noNegativeZero(start * (1 - t) + end * t));
  }
  out.push(noNegativeZero(end));
  return out;
}

/** Limits `x` to `[min, max]`, both ends included. */
export function clamp(x: number, min: number, max: number): number {
  assertFinite(x, 'x');
  assertOrdered(min, max);
  return noNegativeZero(Math.min(Math.max(x, min), max));
}

/** Linear interpolation. `t` outside `[0, 1]` extrapolates. Exact at both ends. */
export function lerp(start: number, end: number, t: number): number {
  assertFinite(start, 'start');
  assertFinite(end, 'end');
  assertFinite(t, 't');
  return noNegativeZero(start * (1 - t) + end * t);
}

/** The `t` for which `lerp(start, end, t) === x`. */
export function inverseLerp(start: number, end: number, x: number): number {
  assertFinite(start, 'start');
  assertFinite(end, 'end');
  assertFinite(x, 'x');
  if (start === end) throw new InvalidArgumentError('start and end must differ');
  return noNegativeZero((x - start) / (end - start));
}

/** Maps `x` from one range onto another: `remap(5, 0, 10, 0, 100)` → `50`. */
export function remap(x: number, inStart: number, inEnd: number, outStart: number, outEnd: number): number {
  return lerp(outStart, outEnd, inverseLerp(inStart, inEnd, x));
}

/** Is `x` inside the interval? Defaults to `[min, max)`, the usual half-open range. */
export function inRange(x: number, min: number, max: number, bounds: Bounds = '[)'): boolean {
  assertFinite(x, 'x');
  assertOrdered(min, max);
  const lowOk = bounds[0] === '[' ? x >= min : x > min;
  const highOk = bounds[1] === ']' ? x <= max : x < max;
  return lowOk && highOk;
}

/** `10 ** k` for k = 0..22: every one is a double with no rounding error. */
const EXACT_POW10: readonly number[] = (() => {
  const out = [1];
  for (let k = 1; k <= 22; k++) out.push(out[k - 1]! * 10);
  return out;
})();
const MAX_EXACT_POW10 = EXACT_POW10.length - 1;

/** The float fast path only handles quotients below 2^50 (see `roundedQuotient`). */
const FAST_LIMIT = 2 ** 50;
/** Relative error budget of a fast-path quotient: 2^-50, four times the worst case (2^-52). */
const FAST_MARGIN = 2 ** -50;

/*
 * Why the fast path agrees with the exact one (`internal/round.ts`).
 *
 * `round` works on D, the shortest decimal text of `x` (`String(x)`). D is within
 * half an ulp of x, so |D − x| ≤ |x|·2^-53 for every normal double. The fast path
 * computes q = fl(|x| · 10^p) (or a quotient with at most one more rounding), so
 * |q − |D|·10^p| ≤ q·3·2^-53 < q·2^-50 (FAST_MARGIN). With q < 2^50 the integer
 * and fractional parts of q are exact, so when the fraction is farther than the
 * margin from every boundary the mode cares about (½ for the half modes, 0 and 1
 * for the directed ones) the true value sits strictly on the same side and the
 * rounded integer is known. The result n / 10^p (or n · 10^p) of two exact doubles
 * is correctly rounded, which is what the exact path's `Number(n + "e" + -p)` returns.
 * Subnormal x only reach quotients far below ½, so only their sign matters.
 *
 * Near a boundary the fast path proves "nothing to round" or gives up: if the
 * candidate integer n converts back to |x| exactly, then n·10^-p is the only
 * p-place decimal that rounds to x (the gap 10^-p is over four ulps wide when
 * |x|·10^p < 2^50), and the shortest text D has no more places than it, so D is
 * that decimal and x is already rounded. Anything else, including ties and
 * 'unnecessary', goes to the exact path.
 */

/**
 * The rounded integer for a non-negative float quotient `scaled` that is within
 * `scaled · 2^-52` of the true one, or `undefined` when the true quotient may lie
 * on either side of a rounding boundary.
 */
function roundedQuotient(scaled: number, negative: boolean, mode: RoundingMode): number | undefined {
  const whole = Math.trunc(scaled);
  const fraction = scaled - whole;
  const margin = scaled * FAST_MARGIN;
  switch (mode) {
    case 'halfUp':
    case 'halfDown':
    case 'halfEven': {
      if (Math.abs(fraction - 0.5) <= margin) return undefined;
      return fraction < 0.5 ? whole : whole + 1;
    }
    case 'unnecessary': {
      return undefined;
    }
    default: {
      if (fraction <= margin || fraction >= 1 - margin) return undefined;
      const away = mode === 'up' || (mode === 'ceiling' && !negative) || (mode === 'floor' && negative);
      return away ? whole + 1 : whole;
    }
  }
}

function assertPlaces(places: number): void {
  if (!Number.isSafeInteger(places) || Math.abs(places) > 1000) {
    throw new InvalidArgumentError(`places must be an integer within ±1000, got ${places}`);
  }
}

/**
 * Rounds the number you typed, not its binary approximation:
 * `round(1.005, 2)` is `1.01` (plain `Math.round(1.005 * 100) / 100` gives `1`).
 * Negative `places` round to tens, hundreds, ...
 *
 * Most calls take a float fast path that is proven to give the same result as
 * exact decimal rounding; only values within a few ulps of a tie (or of a whole
 * unit, for the directed modes) pay for the exact path.
 */
export function round(x: number, places = 0, mode: RoundingMode = 'halfUp'): number {
  assertFinite(x, 'x');
  assertPlaces(places);
  const magnitude = Math.abs(x);
  if (Math.abs(places) <= MAX_EXACT_POW10 && magnitude <= Number.MAX_SAFE_INTEGER) {
    const unit = EXACT_POW10[Math.abs(places)]!;
    const scaled = places >= 0 ? magnitude * unit : magnitude / unit;
    if (scaled < FAST_LIMIT) {
      const rounded = roundedQuotient(scaled, x < 0, mode);
      if (rounded !== undefined) {
        const result = places >= 0 ? rounded / unit : rounded * unit;
        return noNegativeZero(x < 0 ? -result : result);
      }
      const candidate = Math.round(scaled);
      if ((places >= 0 ? candidate / unit : candidate * unit) === magnitude) return noNegativeZero(x);
    }
  }
  return roundExact(x, places, mode);
}

/**
 * `step` as `coefficient / 10^exponent` with both small enough for the fast path,
 * or `undefined`. The first exponent whose candidate converts back to `step` gives
 * its shortest decimal text (the same argument as for `round`).
 */
function decimalStep(step: number): { coefficient: number; exponent: number } | undefined {
  for (let exponent = 0; exponent <= MAX_EXACT_POW10; exponent++) {
    const power = EXACT_POW10[exponent]!;
    const coefficient = Math.round(step * power);
    if (coefficient >= FAST_LIMIT) return undefined;
    if (coefficient / power === step) return { coefficient, exponent };
  }
  return undefined;
}

/** Rounds to the nearest multiple of `step`, measured from zero: `roundTo(127.3, 5)` → `125`. */
export function roundTo(x: number, step: number, mode: RoundingMode = 'halfUp'): number {
  assertFinite(x, 'x');
  assertFinite(step, 'step');
  if (step <= 0) throw new InvalidArgumentError(`step must be positive, got ${step}`);
  const magnitude = Math.abs(x);
  const unit = magnitude <= Number.MAX_SAFE_INTEGER ? decimalStep(step) : undefined;
  if (unit !== undefined) {
    const power = EXACT_POW10[unit.exponent]!;
    const scaled = magnitude / step;
    if (scaled < FAST_LIMIT) {
      const multiple = roundedQuotient(scaled, x < 0, mode);
      if (multiple === undefined) {
        const digits = Math.round(scaled) * unit.coefficient;
        if (digits < FAST_LIMIT && digits / power === magnitude) return noNegativeZero(x);
      } else {
        // An exact integer product below 2^53 divided by an exact power of ten: correctly rounded.
        const digits = multiple * unit.coefficient;
        if (digits <= Number.MAX_SAFE_INTEGER) return noNegativeZero((x < 0 ? -digits : digits) / power);
      }
    }
  }
  return roundToExact(x, step, mode);
}

/**
 * Rounds to `digits` significant figures, on the number you typed:
 * `roundToSignificant(123_456, 2)` is `120000`, `roundToSignificant(0.012_345, 3)`
 * is `0.0123`. A number with fewer digits is returned as is (nothing is padded).
 * Works for every finite double, from subnormals to `6.02214076e23` and beyond:
 * the digits are those of the number's shortest decimal text, `String(x)`.
 * Throws `NumericRangeError` only when rounding up past the largest double
 * (`roundToSignificant(1.7976931348623157e308, 1)` would be `2e308`).
 */
export function roundToSignificant(x: number, digits: number, mode: RoundingMode = 'halfUp'): number {
  assertFinite(x, 'x');
  if (!Number.isSafeInteger(digits) || digits < 1 || digits > 1000) {
    throw new InvalidArgumentError(`digits must be an integer from 1 to 1000, got ${digits}`);
  }
  if (x === 0) return 0;
  // The shortest text, not `partsFromNumber`: past 2^53 its digits are still the number you typed.
  const { coefficient, scale } = parseDecimalString(String(x));
  const drop = digitCount(abs(coefficient)) - digits;
  if (drop <= 0) return x;
  const rounded = divideRounded(coefficient, pow10(drop), mode);
  const result = Number(`${rounded}e${drop - scale}`);
  if (!Number.isFinite(result))
    throw new NumericRangeError(`${x} rounded to ${digits} digits is too large to represent`);
  return noNegativeZero(result);
}

const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Counts the significant figures in a written number by the textbook rules:
 * leading zeros never count, zeros between digits always count, and trailing
 * zeros count only when there is a decimal point.
 * `'1200'` → 2, `'1200.'` → 4, `'0.00120'` → 3, `'1.20e3'` → 3. The exponent
 * is ignored. Zero counts its written zeros after the point (`'0'` → 1, `'0.00'` → 2).
 * Pass the text (or a `Decimal`, whose scale is its written precision):
 * a JS number cannot tell `1.20` from `1.2`. Anything else throws `NumberFormatError`.
 */
export function significantDigits(value: string | Decimal): number {
  const text = typeof value === 'string' ? value.trim() : value.toString();
  if (!PLAIN_NUMBER.test(text)) throw new NumberFormatError(`"${text}" is not a plain decimal number`);
  const mantissa = text.replace(/^[+-]/, '').split(/e/i)[0] ?? '';
  const point = mantissa.indexOf('.');
  const digits = mantissa.replace('.', '');
  const significant = digits.replace(/^0+/, '');
  if (significant === '') return point === -1 ? 1 : Math.max(1, mantissa.length - point - 1);
  return point === -1 ? significant.replace(/0+$/, '').length : significant.length;
}

/**
 * Tolerant equality for floats. `tolerance` is relative to the larger
 * magnitude (and absolute near zero), so it works for both `0.1 + 0.2 ≈ 0.3`
 * and `1e12 + 0.001 ≈ 1e12`.
 */
export function approxEqual(a: number, b: number, tolerance = 1e-9): boolean {
  assertFinite(a, 'a');
  assertFinite(b, 'b');
  if (tolerance < 0) throw new InvalidArgumentError('tolerance must be non-negative');
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}
