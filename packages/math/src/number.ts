/**
 * Helpers for ordinary JS numbers: the fast, approximate 80% case (UI, geometry,
 * charts). For money or anything that must be exact, use `@arki/math/decimal`.
 *
 * Every input must be finite; `NaN` and `±Infinity` throw rather than spread.
 * Results never carry `-0`.
 */

import type { RoundingMode } from './rounding.js';
import { InvalidArgumentError } from './errors.js';
import { divideRounded, pow10 } from './internal/bigint.js';
import { partsFromNumber } from './internal/parse.js';

/** Interval notation: `[` / `]` include the bound, `(` / `)` exclude it. */
export type Bounds = '[]' | '[)' | '(]' | '()';

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
