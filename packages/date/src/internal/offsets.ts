/**
 * UTC offsets of time zones, answered from a per-day cache.
 *
 * Temporal answers "what is the offset at this moment" correctly, but each
 * answer builds a ZonedDateTime (hundreds of nanoseconds on V8). Offsets change
 * only at transitions, so the cache keeps one entry per UTC day: the day's
 * offset, or, for the few days holding a transition, the exact moment of the
 * change (found by binary search to the millisecond). Only offset queries are
 * used; the polyfill's transition search can miss transitions (it reports none
 * after 2028 for Africa/Casablanca on V8).
 *
 * Assumption: a zone never changes its offset and changes it back within one
 * UTC day. A day whose start and end offsets differ, but whose change point is
 * not a single step, is marked complex and always asks Temporal.
 *
 * All values are epoch or wall-clock milliseconds. A wall-clock millisecond is
 * the zone's local reading counted as if it were UTC.
 */

import type { Disambiguation } from '../types.js';
import { Temporal } from '../types.js';
import { MS_PER_DAY } from './civil.js';

/** A day's offset; or one change at `at` from `before` to `after`; or `null` when the day is complex. */
type Day = number | Readonly<{ before: number; at: number; after: number }> | null;

const MAX_ZONES = 64;
const MAX_DAYS_PER_ZONE = 16_384;
const zones = new Map<string, Map<number, Day>>();

function daysOf(zone: string): Map<number, Day> {
  let days = zones.get(zone);
  if (days === undefined) {
    if (zones.size >= MAX_ZONES) zones.clear();
    days = new Map();
    zones.set(zone, days);
  }
  return days;
}

/** Temporal's offset at an exact millisecond. Throws `RangeError` for an unknown zone, as Temporal does. */
function temporalOffset(zone: string, epochMs: number): number {
  return new Temporal.ZonedDateTime(BigInt(epochMs) * 1_000_000n, zone).offsetNanoseconds / 1_000_000;
}

function describeDay(zone: string, day: number): Day {
  const start = day * MS_PER_DAY;
  const last = start + MS_PER_DAY - 1;
  const first = temporalOffset(zone, start);
  const final = temporalOffset(zone, last);
  if (first === final) return first;
  let low = start;
  let high = last;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (temporalOffset(zone, middle) === first) low = middle;
    else high = middle;
  }
  // One clean step: the offset right after the change is already the day's final offset.
  return temporalOffset(zone, high) === final ? { before: first, at: high, after: final } : null;
}

function dayOf(zone: string, day: number): Day {
  const days = daysOf(zone);
  const cached = days.get(day);
  if (cached !== undefined) return cached;
  const described = describeDay(zone, day);
  if (days.size >= MAX_DAYS_PER_ZONE) days.clear();
  days.set(day, described);
  return described;
}

/** The zone's UTC offset in milliseconds at an exact moment (east positive). */
export function offsetAt(zone: string, epochMs: number): number {
  const day = dayOf(zone, Math.floor(epochMs / MS_PER_DAY));
  if (typeof day === 'number') return day;
  if (day === null) return temporalOffset(zone, epochMs);
  return epochMs < day.at ? day.before : day.after;
}

/** The offset when it is the same on every day touching `[from, to]` (the common case), else `undefined`. */
function uniformOffset(zone: string, from: number, to: number): number | undefined {
  const last = Math.floor(to / MS_PER_DAY);
  let day = Math.floor(from / MS_PER_DAY);
  const offset = dayOf(zone, day);
  if (typeof offset !== 'number') return undefined;
  while (++day <= last) if (dayOf(zone, day) !== offset) return undefined;
  return offset;
}

/** The single offset change in `[from, to]`: `undefined` when there is none, `null` when there are several or a complex day. */
function changeBetween(
  zone: string,
  from: number,
  to: number,
): Readonly<{ before: number; at: number; after: number }> | null | undefined {
  let change: Readonly<{ before: number; at: number; after: number }> | undefined;
  let previous: number | undefined;
  for (let day = Math.floor(from / MS_PER_DAY); day <= Math.floor(to / MS_PER_DAY); day++) {
    const entry = dayOf(zone, day);
    if (entry === null) return null;
    const startOffset = typeof entry === 'number' ? entry : entry.before;
    // A change exactly at midnight shows up as two days with different offsets.
    if (previous !== undefined && startOffset !== previous) {
      if (change !== undefined) return null;
      change = { before: previous, at: day * MS_PER_DAY, after: startOffset };
    }
    if (typeof entry !== 'number') {
      if (change !== undefined) return null;
      change = entry;
    }
    previous = typeof entry === 'number' ? entry : entry.after;
  }
  // A change on a scanned day but outside the window does not affect readings inside it.
  if (change !== undefined && (change.at <= from || change.at > to)) return undefined;
  return change;
}

/** How a wall-clock reading maps onto exact time when the zone has at most one transition around it. */
export type WallResolution =
  | Readonly<{ kind: 'unique'; epochMs: number }>
  /** Repeated hour: two moments, `earlier` < `later`. */
  | Readonly<{ kind: 'fold'; earlier: number; later: number }>
  /** Skipped hour: `transition` is the first moment after the gap. */
  | Readonly<{ kind: 'gap'; offsetBefore: number; offsetAfter: number; transition: number }>;

/**
 * The moments a wall-clock reading names in `zone`, with the same ±1 day window
 * Temporal uses. Returns `undefined` when two transitions fall inside that
 * window (rare historical changes); callers then use Temporal itself.
 */
export function resolveWall(zone: string, wallMs: number): WallResolution | undefined {
  const change = changeBetween(zone, wallMs - MS_PER_DAY, wallMs + MS_PER_DAY);
  if (change === null) return undefined;
  if (change === undefined) return { kind: 'unique', epochMs: wallMs - offsetAt(zone, wallMs) };
  const transition = change.at;
  // Read the wall clock with each offset; a reading is real when it lands on its own side of the transition.
  const withBefore = wallMs - change.before;
  const withAfter = wallMs - change.after;
  const beforeIsReal = withBefore < transition;
  const afterIsReal = withAfter >= transition;
  if (beforeIsReal && afterIsReal) {
    return { kind: 'fold', earlier: Math.min(withBefore, withAfter), later: Math.max(withBefore, withAfter) };
  }
  if (beforeIsReal) return { kind: 'unique', epochMs: withBefore };
  if (afterIsReal) return { kind: 'unique', epochMs: withAfter };
  return { kind: 'gap', offsetBefore: change.before, offsetAfter: change.after, transition };
}

/**
 * The exact moment of a wall-clock reading under Temporal's disambiguation
 * rules, or `undefined` when the fast path does not apply (`reject` on a
 * fold or gap, or several transitions nearby): callers then use Temporal.
 */
export function epochFromWall(
  zone: string,
  wallMs: number,
  disambiguation: Disambiguation = 'compatible',
): number | undefined {
  const uniform = uniformOffset(zone, wallMs - MS_PER_DAY, wallMs + MS_PER_DAY);
  if (uniform !== undefined) return wallMs - uniform;
  const resolution = resolveWall(zone, wallMs);
  if (resolution === undefined) return undefined;
  switch (resolution.kind) {
    case 'unique': {
      return resolution.epochMs;
    }
    case 'fold': {
      if (disambiguation === 'reject') return undefined;
      return disambiguation === 'later' ? resolution.later : resolution.earlier;
    }
    case 'gap': {
      if (disambiguation === 'reject') return undefined;
      // `earlier` reads the skipped time with the offset after the gap; `later` and
      // `compatible` with the offset before it, landing after the gap.
      return disambiguation === 'earlier' ? wallMs - resolution.offsetAfter : wallMs - resolution.offsetBefore;
    }
  }
}

/** The first moment of the day whose midnight is `wallMs` (Temporal's `startOfDay`). */
export function startOfDayEpoch(zone: string, wallMs: number): number | undefined {
  const uniform = uniformOffset(zone, wallMs - MS_PER_DAY, wallMs + MS_PER_DAY);
  if (uniform !== undefined) return wallMs - uniform;
  const resolution = resolveWall(zone, wallMs);
  if (resolution === undefined) return undefined;
  if (resolution.kind === 'unique') return resolution.epochMs;
  return resolution.kind === 'fold' ? resolution.earlier : resolution.transition;
}
