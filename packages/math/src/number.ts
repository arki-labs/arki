/**
 * Helpers for ordinary JS numbers: the fast, approximate 80% case (UI, geometry,
 * charts). For money or anything that must be exact, use `@arki/math/decimal`.
 *
 * Every input must be finite; `NaN` and `±Infinity` throw rather than spread.
 * Results never carry `-0`.
 */

import type { RoundingMode } from './rounding.js';
import { InvalidArgumentError, ResourceLimitError } from './errors.js';
import { divideRounded, pow10 } from './internal/bigint.js';
import { partsFromNumber } from './internal/parse.js';

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

/**
 * Rounds the number you typed, not its binary approximation:
 * `round(1.005, 2)` is `1.01` (plain `Math.round(1.005 * 100) / 100` gives `1`).
 * Negative `places` round to tens, hundreds, ...
 */
export function round(x: number, places = 0, mode: RoundingMode = 'halfUp'): number {
  assertFinite(x, 'x');
  if (!Number.isSafeInteger(places) || Math.abs(places) > 1000) {
    throw new InvalidArgumentError(`places must be an integer within ±1000, got ${places}`);
  }
  const { coefficient, scale } = partsFromNumber(x);
  if (places >= scale) return noNegativeZero(x);
  const rounded = divideRounded(coefficient, pow10(scale - places), mode);
  return noNegativeZero(Number(`${rounded}e${-places}`));
}

/** Rounds to the nearest multiple of `step`, measured from zero: `roundTo(127.3, 5)` → `125`. */
export function roundTo(x: number, step: number, mode: RoundingMode = 'halfUp'): number {
  assertFinite(x, 'x');
  assertFinite(step, 'step');
  if (step <= 0) throw new InvalidArgumentError(`step must be positive, got ${step}`);
  const value = partsFromNumber(x);
  const unit = partsFromNumber(step);
  const multiple = divideRounded(value.coefficient * pow10(unit.scale), unit.coefficient * pow10(value.scale), mode);
  return noNegativeZero(Number(`${multiple * unit.coefficient}e${-unit.scale}`));
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
