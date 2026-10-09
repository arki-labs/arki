import { describe, expect, it } from 'vitest';

import type { Interval } from './interval.js';
import type { Instant, PlainDate } from './types.js';
import { instant, plainDate, zoned } from './core.js';
import {
  abuts,
  contains,
  each,
  gap,
  gapsBetween,
  intersection,
  interval,
  intervalEquals,
  intervalLength,
  isEmptyInterval,
  mergeIntervals,
  overlaps,
  range,
  splitByUnit,
  subtract,
  symmetricDifference,
  toISOInterval,
  union,
} from './interval.js';
import { diffElapsed } from './math.js';
import { Temporal } from './types.js';

const d = (text: string): PlainDate => plainDate(text);
const t = (text: string): Instant => instant(text);
const di = (start: string, end: string): Interval<PlainDate> => interval(d(start), d(end));
const ii = (start: string, end: string): Interval<Instant> => interval(t(start), t(end));
const show = (list: readonly Interval[]): string[] => list.map(item => toISOInterval(item));

describe('interval construction', () => {
  it('is half-open by default and normalizes other bounds', () => {
    expect(toISOInterval(di('2026-01-01', '2026-01-05'))).toBe('2026-01-01/2026-01-05');
    // An inclusive end on a calendar date means "through that whole day": one more day.
    expect(toISOInterval(interval(d('2026-01-01'), d('2026-01-05'), { bounds: '[]' }))).toBe('2026-01-01/2026-01-06');
    expect(toISOInterval(interval(d('2026-01-01'), d('2026-01-05'), { bounds: '()' }))).toBe('2026-01-02/2026-01-05');
    expect(toISOInterval(interval(d('2026-01-01'), d('2026-01-05'), { bounds: '(]' }))).toBe('2026-01-02/2026-01-06');
    // On exact instants the next representable value is one nanosecond later.
    expect(toISOInterval(interval(t('2026-01-01T00:00Z'), t('2026-01-01T01:00Z'), { bounds: '[]' }))).toBe(
      '2026-01-01T00:00:00Z/2026-01-01T01:00:00.000000001Z',
    );
    expect(interval(t('2026-01-01T00:00Z'), t('2026-01-01T01:00Z'), { bounds: '()' }).start.toString()).toBe(
      '2026-01-01T00:00:00.000000001Z',
    );
  });

  it('allows the empty interval but rejects reversed ends and mixed kinds', () => {
    expect(isEmptyInterval(di('2026-01-01', '2026-01-01'))).toBe(true);
    expect(isEmptyInterval(di('2026-01-01', '2026-01-02'))).toBe(false);
    expect(() => di('2026-01-02', '2026-01-01')).toThrow(RangeError);
    // (a, a) would start after it ends once normalized.
    expect(() => interval(d('2026-01-01'), d('2026-01-01'), { bounds: '()' })).toThrow(RangeError);
    // @ts-expect-error — a PlainDate interval cannot end at an Instant
    expect(() => interval(d('2026-01-01'), t('2026-01-02T00:00Z'))).toThrow(TypeError);
  });

  it('compares intervals by their ends', () => {
    expect(intervalEquals(di('2026-01-01', '2026-01-05'), di('2026-01-01', '2026-01-05'))).toBe(true);
    expect(intervalEquals(di('2026-01-01', '2026-01-05'), di('2026-01-01', '2026-01-06'))).toBe(false);
    const a = interval(
      zoned('2026-01-01T02:00+02:00[Europe/Bucharest]'),
      zoned('2026-01-01T03:00+02:00[Europe/Bucharest]'),
    );
    const b = interval(zoned('2026-01-01T00:00+00:00[Europe/London]'), zoned('2026-01-01T01:00+00:00[Europe/London]'));
    expect(intervalEquals(a, b)).toBe(true);
  });
});

describe('predicates', () => {
  const jan = di('2026-01-01', '2026-02-01');

  it('contains points half-open and intervals inclusively', () => {
    expect(contains(jan, d('2026-01-01'))).toBe(true);
    expect(contains(jan, d('2026-01-31'))).toBe(true);
    expect(contains(jan, d('2026-02-01'))).toBe(false);
    expect(contains(jan, di('2026-01-10', '2026-02-01'))).toBe(true);
    expect(contains(jan, di('2026-01-10', '2026-02-02'))).toBe(false);
    expect(contains(jan, di('2026-01-10', '2026-01-10'))).toBe(true);
    expect(contains(di('2026-01-01', '2026-01-01'), d('2026-01-01'))).toBe(false);
    const hour = ii('2026-01-01T00:00Z', '2026-01-01T01:00Z');
    expect(contains(hour, t('2026-01-01T00:59:59.999999999Z'))).toBe(true);
    expect(contains(hour, t('2026-01-01T01:00Z'))).toBe(false);
  });

  it('treats touching intervals as abutting, not overlapping', () => {
    const feb = di('2026-02-01', '2026-03-01');
    expect(overlaps(jan, feb)).toBe(false);
    expect(abuts(jan, feb)).toBe(true);
    expect(abuts(feb, jan)).toBe(true);
    expect(overlaps(jan, di('2026-01-31', '2026-02-02'))).toBe(true);
    expect(abuts(jan, di('2026-01-31', '2026-02-02'))).toBe(false);
    // An empty interval strictly inside another still overlaps nothing.
    expect(overlaps(jan, di('2026-01-10', '2026-01-10'))).toBe(false);
    expect(overlaps(ii('2026-01-01T00:00Z', '2026-01-01T02:00Z'), ii('2026-01-01T01:00Z', '2026-01-01T03:00Z'))).toBe(
      true,
    );
  });
});

describe('set operations', () => {
  it('intersects, or returns null when nothing is shared', () => {
    const x = intersection(di('2026-01-01', '2026-01-10'), di('2026-01-05', '2026-01-20'));
    expect(x && toISOInterval(x)).toBe('2026-01-05/2026-01-10');
    expect(intersection(di('2026-01-01', '2026-01-10'), di('2026-01-10', '2026-01-20'))).toBeNull();
    const y = intersection(ii('2026-01-01T00:00Z', '2026-01-01T02:00Z'), ii('2026-01-01T01:00Z', '2026-01-01T03:00Z'));
    expect(y && toISOInterval(y)).toBe('2026-01-01T01:00:00Z/2026-01-01T02:00:00Z');
  });

  it('unions overlapping and touching pieces but keeps gaps open', () => {
    expect(
      show(union(di('2026-01-10', '2026-01-20'), di('2026-01-01', '2026-01-05'), di('2026-01-05', '2026-01-08'))),
    ).toEqual(['2026-01-01/2026-01-08', '2026-01-10/2026-01-20']);
    expect(
      show(union(ii('2026-01-01T00:00Z', '2026-01-01T02:00Z'), ii('2026-01-01T01:00Z', '2026-01-01T03:00Z'))),
    ).toEqual(['2026-01-01T00:00:00Z/2026-01-01T03:00:00Z']);
    expect(show(mergeIntervals([di('2026-01-03', '2026-01-03')]))).toEqual([]);
  });

  it('finds the gap only between separated intervals', () => {
    const g = gap(di('2026-01-10', '2026-01-20'), di('2026-01-01', '2026-01-05'));
    expect(g && toISOInterval(g)).toBe('2026-01-05/2026-01-10');
    expect(gap(di('2026-01-01', '2026-01-05'), di('2026-01-05', '2026-01-10'))).toBeNull();
    expect(gap(di('2026-01-01', '2026-01-06'), di('2026-01-05', '2026-01-10'))).toBeNull();
    const h = gap(ii('2026-01-01T00:00Z', '2026-01-01T01:00Z'), ii('2026-01-01T02:00Z', '2026-01-01T03:00Z'));
    expect(h && toISOInterval(h)).toBe('2026-01-01T01:00:00Z/2026-01-01T02:00:00Z');
    expect(
      show(
        gapsBetween([di('2026-01-10', '2026-01-12'), di('2026-01-01', '2026-01-05'), di('2026-01-04', '2026-01-07')]),
      ),
    ).toEqual(['2026-01-07/2026-01-10']);
  });

  it('subtracts into zero, one or two pieces', () => {
    const a = di('2026-01-01', '2026-01-31');
    expect(show(subtract(a, di('2026-01-10', '2026-01-20')))).toEqual([
      '2026-01-01/2026-01-10',
      '2026-01-20/2026-01-31',
    ]);
    expect(show(subtract(a, di('2025-12-01', '2026-01-10')))).toEqual(['2026-01-10/2026-01-31']);
    expect(show(subtract(a, di('2025-12-01', '2026-03-01')))).toEqual([]);
    expect(show(subtract(a, di('2026-02-01', '2026-03-01')))).toEqual(['2026-01-01/2026-01-31']);
    expect(
      show(subtract(ii('2026-01-01T00:00Z', '2026-01-01T03:00Z'), ii('2026-01-01T01:00Z', '2026-01-01T02:00Z'))),
    ).toEqual(['2026-01-01T00:00:00Z/2026-01-01T01:00:00Z', '2026-01-01T02:00:00Z/2026-01-01T03:00:00Z']);
  });

  it('keeps the points in exactly one interval for a symmetric difference', () => {
    expect(show(symmetricDifference(di('2026-01-01', '2026-01-10'), di('2026-01-05', '2026-01-20')))).toEqual([
      '2026-01-01/2026-01-05',
      '2026-01-10/2026-01-20',
    ]);
    // Touching intervals share no point, so together they form one block.
    expect(show(symmetricDifference(di('2026-01-01', '2026-01-05'), di('2026-01-05', '2026-01-09')))).toEqual([
      '2026-01-01/2026-01-09',
    ]);
  });
});

describe('length and splitting', () => {
  it('measures with diff semantics', () => {
    expect(intervalLength(di('2026-01-01', '2026-12-31'), 'day')).toBe(364);
    expect(intervalLength(di('2026-01-31', '2026-02-28'), 'month', { fractional: true })).toBe(1);
    expect(intervalLength(ii('2026-01-01T00:00Z', '2026-01-01T01:30Z'), 'hour', { fractional: true })).toBe(1.5);
  });

  it('cuts at unit boundaries with partial ends', () => {
    expect(show([...splitByUnit(di('2026-01-15', '2026-03-10'), 'month')])).toEqual([
      '2026-01-15/2026-02-01',
      '2026-02-01/2026-03-01',
      '2026-03-01/2026-03-10',
    ]);
    expect(show([...splitByUnit(ii('2026-01-01T00:30Z', '2026-01-01T02:00Z'), 'hour')])).toEqual([
      '2026-01-01T00:30:00Z/2026-01-01T01:00:00Z',
      '2026-01-01T01:00:00Z/2026-01-01T02:00:00Z',
    ]);
    expect([...splitByUnit(di('2026-01-01', '2026-01-01'), 'day')]).toEqual([]);
    expect(() => [...splitByUnit(di('2026-01-01', '2026-01-10'), 'day', { maxItems: 5 })]).toThrow(RangeError);
  });

  it('splits a zoned interval by calendar day across the DST change', () => {
    const tz = 'Europe/Bucharest';
    const span = interval(zoned({ year: 2026, month: 3, day: 28 }, tz), zoned({ year: 2026, month: 3, day: 31 }, tz));
    const pieces = [...splitByUnit(span, 'day')];
    expect(pieces.map(p => diffElapsed(p.start, p.end, 'hour'))).toEqual([24, 23, 24]);
    expect(pieces[1]?.end.toString()).toBe('2026-03-30T00:00:00+03:00[Europe/Bucharest]');
  });
});

describe('each / range', () => {
  it('anchors every value at the start instead of accumulating', () => {
    const months = [...each(di('2026-01-31', '2026-05-01'), { months: 1 })].map(String);
    expect(months).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('steps instants by time amounts and stops before the end', () => {
    expect([...range(t('2026-01-01T00:00Z'), t('2026-01-01T01:00Z'), { minutes: 20 })].map(String)).toEqual([
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:20:00Z',
      '2026-01-01T00:40:00Z',
    ]);
    expect([...range(d('2026-01-01'), d('2026-01-01'), { days: 1 })]).toEqual([]);
  });

  it('rejects steps that cannot move forward', () => {
    const span = di('2026-01-01', '2026-01-10');
    expect(() => each(span, {})).toThrow(RangeError);
    expect(() => each(span, { days: 0 })).toThrow(RangeError);
    expect(() => each(span, { days: -1 })).toThrow(RangeError);
    expect(() => each(span, { days: 1.5 })).toThrow(RangeError);
    expect(() => range(t('2026-01-01T00:00Z'), t('2026-01-01T01:00Z'), { nanoseconds: 0 })).toThrow(RangeError);
    // @ts-expect-error — a time amount cannot advance a PlainDate; the runtime guard catches it too
    expect(() => [...each(span, { hours: 1 })]).toThrow(RangeError);
  });

  it('throws instead of truncating at maxItems', () => {
    const span = di('2026-01-01', '2026-01-11');
    expect([...each(span, { days: 1 }, { maxItems: 10 })]).toHaveLength(10);
    expect(() => [...each(span, { days: 1 }, { maxItems: 9 })]).toThrow(RangeError);
    expect(() => [...range(t('2026-01-01T00:00Z'), t('2026-01-02T00:00Z'), { seconds: 1 })]).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// properties over seeded random PlainDate intervals

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const BASE = d('2026-01-01');

function randomInterval(next: () => number): Interval<PlainDate> {
  const a = Math.floor(next() * 120);
  const length = Math.floor(next() * 60);
  return interval(BASE.add({ days: a }), BASE.add({ days: a + length }));
}

function pairs(count: number): [Interval<PlainDate>, Interval<PlainDate>][] {
  const next = lcg(20_261_009);
  return Array.from({ length: count }, () => [randomInterval(next), randomInterval(next)]);
}

function assertSortedDisjoint(list: readonly Interval<PlainDate>[]): void {
  for (let index = 1; index < list.length; index++) {
    const before = list[index - 1];
    const after = list[index];
    if (!before || !after) throw new Error('unreachable');
    // Strictly before: merged pieces neither overlap nor touch.
    expect(Temporal.PlainDate.compare(before.end, after.start)).toBeLessThan(0);
  }
}

describe('interval properties (200 seeded pairs)', () => {
  const cases = pairs(200);

  it('intersection is commutative', () => {
    for (const [a, b] of cases) {
      const ab = intersection(a, b);
      const ba = intersection(b, a);
      expect(ab === null ? null : toISOInterval(ab)).toBe(ba === null ? null : toISOInterval(ba));
    }
  });

  it('union is idempotent, sorted and disjoint, and covers exactly the inputs', () => {
    for (const [a, b] of cases) {
      const u = union(a, b);
      assertSortedDisjoint(u);
      expect(show(mergeIntervals(u))).toEqual(show(u));
      for (const day of [a.start, a.end, b.start, b.end, a.start.add({ days: 3 })]) {
        const inInputs = contains(a, day) || contains(b, day);
        expect(u.some(piece => contains(piece, day))).toBe(inInputs);
      }
    }
  });

  it('subtract(a, b) stays inside a and never overlaps b', () => {
    for (const [a, b] of cases) {
      for (const piece of subtract(a, b)) {
        expect(contains(a, piece)).toBe(true);
        expect(overlaps(piece, b)).toBe(false);
        expect(isEmptyInterval(piece)).toBe(false);
      }
    }
  });

  it('splitByUnit pieces are contiguous and rebuild the input', () => {
    for (const [a] of cases) {
      for (const unit of ['day', 'week', 'month'] as const) {
        const pieces = [...splitByUnit(a, unit)];
        if (isEmptyInterval(a)) {
          expect(pieces).toEqual([]);
          continue;
        }
        expect(pieces[0]?.start.equals(a.start)).toBe(true);
        expect(pieces.at(-1)?.end.equals(a.end)).toBe(true);
        for (let index = 1; index < pieces.length; index++) {
          expect(pieces[index]?.start.equals(pieces[index - 1]?.end ?? a.start)).toBe(true);
        }
        expect(pieces.every(piece => !isEmptyInterval(piece))).toBe(true);
        expect(show(mergeIntervals(pieces))).toEqual([toISOInterval(a)]);
      }
    }
  });

  it('each values strictly increase and stay in range', () => {
    for (const [a] of cases) {
      const values = [...each(a, { days: 3 })];
      for (const [index, value] of values.entries()) {
        expect(contains(a, value)).toBe(true);
        const previous = values[index - 1];
        if (previous) expect(previous.until(value).days).toBe(3);
      }
      expect(values.length).toBe(Math.ceil(a.start.until(a.end).days / 3));
    }
  });
});
