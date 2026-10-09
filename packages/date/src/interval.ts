/**
 * Interval algebra over half-open ranges `[start, end)`.
 *
 * Policies (one for the whole package):
 * - Every `Interval` is half-open: `start` is included, `end` is excluded.
 *   Other bound notations are normalized on construction by `interval()`.
 * - `[a, a)` is a valid, empty interval. It contains no point and overlaps nothing.
 * - Touching intervals (`[a, b)` and `[b, c)`) do not overlap, but `union` and
 *   `mergeIntervals` join them, because together they cover `[a, c)` with no gap.
 * - Both ends must be the same kind of value; mixing kinds is a `TypeError`.
 *   Zoned values are ordered by their exact instant.
 * - Iterators (`each`, `range`, `splitByUnit`) stop with a `RangeError` once
 *   they would produce more than `maxItems` values (default 10 000). They never
 *   truncate silently.
 */

import type { DiffOptions } from './math.js';
import type { Amount, AmountFor, Bounds, Point, UnitFor, WeekRules } from './types.js';
import { toDuration } from './internal/amount.js';
import { assertSameKind } from './internal/kind.js';
import { add, diff, internal, nextBoundary } from './math.js';
import { isPlainDate, isPoint, Temporal } from './types.js';

/**
 * A half-open range `[start, end)`: `start` is included, `end` is **excluded**.
 * `start` is never after `end`; `start == end` is the empty interval.
 */
export type Interval<T extends Point = Point> = Readonly<{ start: T; end: T }>;

export type IntervalOptions = Readonly<{
  /** Bound notation of the inputs: `[` / `]` inclusive, `(` / `)` exclusive. Default `[)`. */
  bounds?: Bounds;
}>;

export type IterateOptions = Readonly<{
  /** Throw a `RangeError` rather than produce more than this many values. Default 10 000. */
  maxItems?: number;
}>;

export type SplitOptions = Readonly<{ week?: WeekRules; maxItems?: number }>;

const DEFAULT_MAX_ITEMS = 10_000;

function cmp(a: Point, b: Point): number {
  return internal.comparePoints(a, b);
}

/** Build an interval whose ends are already known to be ordered. */
function make<T extends Point>(start: T, end: T): Interval<T> {
  return Object.freeze({ start, end });
}

function earlier<T extends Point>(a: T, b: T): T {
  return cmp(a, b) <= 0 ? a : b;
}

function later<T extends Point>(a: T, b: T): T {
  return cmp(a, b) >= 0 ? a : b;
}

/** The smallest step of a kind: one day for a `PlainDate`, one nanosecond otherwise. */
function smallestStep(value: Point): Temporal.Duration {
  return Temporal.Duration.from(isPlainDate(value) ? { days: 1 } : { nanoseconds: 1 });
}

function assertSameIntervalKind(a: Interval, b: Interval, operation: string): void {
  assertSameKind(a.start, b.start, operation);
}

// ---------------------------------------------------------------------------
// construction

/**
 * A half-open interval `[start, end)`. With `bounds`, the inputs are read in
 * that notation and normalized: an inclusive end (`]`) or an exclusive start
 * (`(`) moves forward by one day on a `PlainDate` and one nanosecond otherwise.
 * `interval(d, d, { bounds: '[]' })` is the one-day interval `[d, d + 1 day)`.
 * Throws `RangeError` when `start` is after `end` once normalized; mixed kinds throw `TypeError`.
 */
export function interval<T extends Point>(start: T, end: NoInfer<T>, options?: IntervalOptions): Interval<T> {
  assertSameKind(start, end, 'interval');
  const bounds = options?.bounds ?? '[)';
  const first = bounds.startsWith('(') ? add(start, smallestStep(start)) : start;
  const last = bounds.endsWith(']') ? add(end, smallestStep(end)) : end;
  if (cmp(first, last) > 0) {
    throw new RangeError(`interval: start ${first.toString()} is after end ${last.toString()}`);
  }
  return make(first, last);
}

/** Does the interval cover nothing (`start == end`)? */
export function isEmptyInterval(i: Interval): boolean {
  return cmp(i.start, i.end) === 0;
}

/** Same start and same end (zoned values compare by instant, so the zones may differ). */
export function intervalEquals<T extends Point>(a: Interval<T>, b: Interval<NoInfer<T>>): boolean {
  assertSameIntervalKind(a, b, 'intervalEquals');
  return cmp(a.start, b.start) === 0 && cmp(a.end, b.end) === 0;
}

// ---------------------------------------------------------------------------
// predicates

/**
 * For a point: `start ≤ value < end`. For an interval: `b` lies entirely
 * inside `i` (`i.start ≤ b.start` and `b.end ≤ i.end`); an empty `b` inside `i` counts.
 */
export function contains<T extends Point>(i: Interval<T>, value: NoInfer<T> | Interval<NoInfer<T>>): boolean {
  if (isPoint(value)) {
    assertSameKind(i.start, value, 'contains');
    return cmp(i.start, value) <= 0 && cmp(value, i.end) < 0;
  }
  assertSameIntervalKind(i, value, 'contains');
  return cmp(i.start, value.start) <= 0 && cmp(value.end, i.end) <= 0;
}

/** Do the intervals share at least one point? Touching intervals and empty intervals never overlap. */
export function overlaps<T extends Point>(a: Interval<T>, b: Interval<NoInfer<T>>): boolean {
  assertSameIntervalKind(a, b, 'overlaps');
  if (isEmptyInterval(a) || isEmptyInterval(b)) return false;
  return cmp(a.start, b.end) < 0 && cmp(b.start, a.end) < 0;
}

/** Does one interval end exactly where the other starts (`a.end == b.start` or `b.end == a.start`)? */
export function abuts<T extends Point>(a: Interval<T>, b: Interval<NoInfer<T>>): boolean {
  assertSameIntervalKind(a, b, 'abuts');
  return cmp(a.end, b.start) === 0 || cmp(b.end, a.start) === 0;
}

// ---------------------------------------------------------------------------
// set operations

/** The points in both intervals, or `null` when they share none. */
export function intersection<T extends Point>(a: Interval<T>, b: Interval<NoInfer<T>>): Interval<T> | null {
  assertSameIntervalKind(a, b, 'intersection');
  const start = later(a.start, b.start);
  const end = earlier(a.end, b.end);
  return cmp(start, end) < 0 ? make(start, end) : null;
}

/**
 * Sort and merge: overlapping and touching intervals join; empty intervals are
 * dropped (they cover nothing). The result is sorted, disjoint and never touching.
 */
export function mergeIntervals<T extends Point>(list: readonly Interval<T>[]): readonly Interval<T>[] {
  const [first] = list;
  if (first) for (const item of list) assertSameIntervalKind(first, item, 'mergeIntervals');
  const sorted = list
    .filter(item => !isEmptyInterval(item))
    .toSorted((x, y) => cmp(x.start, y.start) || cmp(x.end, y.end));
  const merged: Interval<T>[] = [];
  for (const item of sorted) {
    const last = merged.at(-1);
    if (last && cmp(item.start, last.end) <= 0) {
      merged[merged.length - 1] = make(last.start, later(last.end, item.end));
    } else {
      merged.push(item);
    }
  }
  return Object.freeze(merged);
}

/**
 * Everything covered by any of the intervals, as sorted disjoint pieces.
 * Overlapping and touching intervals merge; a gap is never filled in.
 */
export function union<T extends Point>(
  a: Interval<T>,
  ...rest: readonly Interval<NoInfer<T>>[]
): readonly Interval<T>[] {
  return mergeIntervals([a, ...rest]);
}

/** The interval strictly between two separated intervals, or `null` when they overlap or touch. */
export function gap<T extends Point>(a: Interval<T>, b: Interval<NoInfer<T>>): Interval<T> | null {
  if (overlaps(a, b) || abuts(a, b)) return null;
  if (cmp(a.end, b.start) < 0) return make(a.end, b.start);
  if (cmp(b.end, a.start) < 0) return make(b.end, a.start);
  return null;
}

/** The parts of `a` not covered by `b`: zero, one or two pieces, in order. */
export function subtract<T extends Point>(a: Interval<T>, b: Interval<NoInfer<T>>): readonly Interval<T>[] {
  if (isEmptyInterval(a)) return Object.freeze([]);
  if (!overlaps(a, b)) return Object.freeze([a]);
  const pieces: Interval<T>[] = [];
  if (cmp(a.start, b.start) < 0) pieces.push(make(a.start, b.start));
  if (cmp(b.end, a.end) < 0) pieces.push(make(b.end, a.end));
  return Object.freeze(pieces);
}

/** The points in exactly one of the two intervals, as sorted disjoint pieces. */
export function symmetricDifference<T extends Point>(a: Interval<T>, b: Interval<NoInfer<T>>): readonly Interval<T>[] {
  return mergeIntervals([...subtract(a, b), ...subtract(b, a)]);
}

/** The holes between the merged intervals, in order (empty when they form one block). */
export function gapsBetween<T extends Point>(list: readonly Interval<T>[]): readonly Interval<T>[] {
  const merged = mergeIntervals(list);
  const gaps: Interval<T>[] = [];
  for (let index = 1; index < merged.length; index++) {
    const before = merged[index - 1];
    const after = merged[index];
    if (before && after) gaps.push(make(before.end, after.start));
  }
  return Object.freeze(gaps);
}

// ---------------------------------------------------------------------------
// measuring and splitting

/**
 * The length of the interval in `unit`: `diff(start, end, unit, options)`.
 * Whole units truncated toward zero unless `fractional: true`.
 */
export function intervalLength<T extends Point>(
  i: Interval<T>,
  unit: UnitFor<NoInfer<T>>,
  options?: DiffOptions,
): number {
  return diff(i.start, i.end, unit, options);
}

function maxItemsOf(options: IterateOptions | undefined, operation: string): number {
  const limit = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`${operation}: maxItems must be a non-negative integer, received ${String(limit)}`);
  }
  return limit;
}

function tooMany(operation: string, limit: number): RangeError {
  return new RangeError(`${operation}: more than ${String(limit)} items; raise maxItems or use a larger step`);
}

function* splitPieces<T extends Point>(
  i: Interval<T>,
  unit: UnitFor<T>,
  options: SplitOptions | undefined,
  limit: number,
): Generator<Interval<T>, void, undefined> {
  let cursor = i.start;
  let count = 0;
  while (cmp(cursor, i.end) < 0) {
    const boundary = nextBoundary(cursor, unit, options);
    if (cmp(boundary, cursor) <= 0) throw new RangeError(`splitByUnit: no progress past ${cursor.toString()}`);
    if (count >= limit) throw tooMany('splitByUnit', limit);
    const end = earlier(boundary, i.end);
    yield make(cursor, end);
    count++;
    cursor = end;
  }
}

/**
 * The interval cut at every `unit` boundary (`startOf` / `nextBoundary`; weeks
 * per `options.week`, ISO by default). The first and last pieces may be
 * partial; together the pieces rebuild the input exactly. An empty interval yields nothing.
 */
export function splitByUnit<T extends Point>(
  i: Interval<T>,
  unit: UnitFor<NoInfer<T>>,
  options?: SplitOptions,
): IterableIterator<Interval<T>> {
  return splitPieces(i, unit, options, maxItemsOf(options, 'splitByUnit'));
}

// ---------------------------------------------------------------------------
// iteration

const AMOUNT_FIELDS = [
  'years',
  'quarters',
  'months',
  'weeks',
  'days',
  'hours',
  'minutes',
  'seconds',
  'milliseconds',
  'microseconds',
  'nanoseconds',
] as const satisfies readonly (keyof Amount)[];

type MutableAmount = { -readonly [K in keyof Amount]: Amount[K] };

function assertStep(step: Amount, operation: string): void {
  let progress = false;
  for (const field of AMOUNT_FIELDS) {
    const value = step[field];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${operation}: step.${field} must be a non-negative integer, received ${String(value)}`);
    }
    if (value > 0) progress = true;
  }
  if (!progress) throw new RangeError(`${operation}: the step needs at least one nonzero field`);
}

function scaleStep(step: Amount, factor: number): Amount {
  const scaled: MutableAmount = {};
  for (const field of AMOUNT_FIELDS) {
    const value = step[field];
    if (value !== undefined) scaled[field] = value * factor;
  }
  return scaled;
}

function* anchoredValues<T extends Point>(
  i: Interval<T>,
  step: Amount,
  limit: number,
  operation: string,
): Generator<T, void, undefined> {
  let previous: T | undefined;
  for (let n = 0; ; n++) {
    const value = add(i.start, toDuration(scaleStep(step, n)));
    if (cmp(value, i.end) >= 0) return;
    if (previous !== undefined && cmp(value, previous) <= 0) {
      throw new RangeError(`${operation}: the step does not move ${previous.toString()} forward`);
    }
    if (n >= limit) throw tooMany(operation, limit);
    yield value;
    previous = value;
  }
}

/**
 * `start`, `start + step`, `start + 2 × step` … while before `end`. Each value
 * is anchored at `start` (`add(start, step × n)`), never accumulated, so a
 * monthly walk from Jan 31 gives Jan 31, Feb 28, Mar 31, Apr 30.
 * The step needs a nonzero field and no negative ones (`RangeError` otherwise).
 */
export function each<T extends Point>(
  i: Interval<T>,
  step: AmountFor<NoInfer<T>>,
  options?: IterateOptions,
): IterableIterator<T> {
  assertStep(step, 'each');
  return anchoredValues(i, step, maxItemsOf(options, 'each'), 'each');
}

/** `each(interval(start, end), step, options)`: values in `[start, end)` anchored at `start`. */
export function range<T extends Point>(
  start: T,
  end: NoInfer<T>,
  step: AmountFor<NoInfer<T>>,
  options?: IterateOptions,
): IterableIterator<T> {
  const span = interval(start, end);
  assertStep(step, 'range');
  return anchoredValues(span, step, maxItemsOf(options, 'range'), 'range');
}

/** ISO 8601 interval text: `start/end` (the end is exclusive). */
export function toISOInterval(i: Interval): string {
  return `${i.start.toString()}/${i.end.toString()}`;
}
