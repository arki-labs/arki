import { describe, expect, it } from 'vitest';

import { instant, plainDate, plainDateTime, zoned } from './core.js';
import { add, ceil, diff, diffElapsed, endOf, floor, nextBoundary, round, set, startOf, sub, until } from './math.js';
import { SUNDAY_WEEK } from './types.js';

const BUC = 'Europe/Bucharest';

describe('add / sub', () => {
  it('clamps month-end overflow by default and can reject it', () => {
    expect(add(plainDate('2026-01-31'), { months: 1 }).toString()).toBe('2026-02-28');
    expect(add(plainDate('2024-01-31'), { months: 1 }).toString()).toBe('2024-02-29');
    expect(() => add(plainDate('2026-01-31'), { months: 1 }, { overflow: 'reject' })).toThrow(RangeError);
  });

  it('expands quarters to three months', () => {
    expect(add(plainDate('2026-01-15'), { quarters: 1 }).toString()).toBe('2026-04-15');
    expect(sub(plainDate('2026-01-15'), { quarters: 2 }).toString()).toBe('2025-07-15');
  });

  it('treats calendar days and elapsed hours differently across DST', () => {
    const beforeSpring = zoned({ year: 2026, month: 3, day: 28, hour: 12 }, BUC);
    const nextDay = add(beforeSpring, { days: 1 });
    const after24h = add(beforeSpring, { hours: 24 });
    expect(nextDay.toString()).toBe('2026-03-29T12:00:00+03:00[Europe/Bucharest]');
    expect(after24h.toString()).toBe('2026-03-29T13:00:00+03:00[Europe/Bucharest]');
    expect(diffElapsed(beforeSpring, nextDay, 'hour')).toBe(23);
    expect(diffElapsed(beforeSpring, after24h, 'hour')).toBe(24);
  });

  it('rejects calendar amounts on an Instant at runtime', () => {
    const i = instant('2026-01-01T00:00:00Z');
    // @ts-expect-error — days are not a TimeAmount
    expect(() => add(i, { days: 1 })).toThrow(RangeError);
    expect(add(i, { hours: 1 }).toString()).toBe('2026-01-01T01:00:00Z');
  });
});

describe('set', () => {
  it('replaces fields and clamps by default', () => {
    expect(set(plainDate('2026-02-10'), { day: 31 }).toString()).toBe('2026-02-28');
    expect(() => set(plainDate('2026-02-10'), { day: 31 }, { overflow: 'reject' })).toThrow(RangeError);
    expect(set(plainDateTime('2026-02-10T10:30'), { hour: 9, minute: 0 }).toString()).toBe('2026-02-10T09:00:00');
  });
});

describe('startOf / nextBoundary / endOf', () => {
  it('handles calendar units on PlainDate with ISO weeks by default', () => {
    const d = plainDate('2026-10-09'); // Friday
    expect(startOf(d, 'week').toString()).toBe('2026-10-05');
    expect(startOf(d, 'week', { week: SUNDAY_WEEK }).toString()).toBe('2026-10-04');
    expect(startOf(d, 'month').toString()).toBe('2026-10-01');
    expect(startOf(d, 'quarter').toString()).toBe('2026-10-01');
    expect(startOf(plainDate('2026-08-20'), 'quarter').toString()).toBe('2026-07-01');
    expect(startOf(d, 'year').toString()).toBe('2026-01-01');
    expect(nextBoundary(d, 'month').toString()).toBe('2026-11-01');
    expect(endOf(d, 'month').toString()).toBe('2026-10-31');
    expect(endOf(plainDate('2026-02-10'), 'month').toString()).toBe('2026-02-28');
    expect(endOf(d, 'week').toString()).toBe('2026-10-11');
  });

  it('keeps the zone and survives a skipped midnight', () => {
    const z = zoned('2026-10-09T15:30:00+03:00[Europe/Bucharest]');
    expect(startOf(z, 'day').toString()).toBe('2026-10-09T00:00:00+03:00[Europe/Bucharest]');
    expect(startOf(z, 'hour').toString()).toBe('2026-10-09T15:00:00+03:00[Europe/Bucharest]');
    expect(endOf(z, 'day').toString()).toBe('2026-10-09T23:59:59.999999999+03:00[Europe/Bucharest]');
    expect(nextBoundary(z, 'month').toString()).toBe('2026-11-01T00:00:00+02:00[Europe/Bucharest]');
    // São Paulo skipped midnight on 2018-11-04 (DST started at 00:00 → 01:00)
    const sp = zoned({ year: 2018, month: 11, day: 4, hour: 12 }, 'America/Sao_Paulo');
    expect(startOf(sp, 'day').toString()).toBe('2018-11-04T01:00:00-02:00[America/Sao_Paulo]');
  });

  it('rounds instants to time units only', () => {
    const i = instant('2026-10-09T15:37:48.123Z');
    expect(startOf(i, 'hour').toString()).toBe('2026-10-09T15:00:00Z');
    expect(endOf(i, 'minute').toString()).toBe('2026-10-09T15:37:59.999999999Z');
  });
});

describe('floor / ceil / round', () => {
  const t = zoned('2026-10-09T15:37:48+03:00[Europe/Bucharest]');

  it('rounds time units with increments', () => {
    expect(floor(t, 'minute', { increment: 15 }).toString()).toBe('2026-10-09T15:30:00+03:00[Europe/Bucharest]');
    expect(ceil(t, 'minute', { increment: 15 }).toString()).toBe('2026-10-09T15:45:00+03:00[Europe/Bucharest]');
    expect(round(t, 'minute', { increment: 15 }).toString()).toBe('2026-10-09T15:45:00+03:00[Europe/Bucharest]');
    expect(round(set(t, { minute: 37, second: 0 }), 'minute', { increment: 15 }).toString()).toBe(
      '2026-10-09T15:30:00+03:00[Europe/Bucharest]',
    );
    expect(round(t, 'hour').toString()).toBe('2026-10-09T16:00:00+03:00[Europe/Bucharest]');
  });

  it('rounds calendar units to the nearest boundary with later ties', () => {
    expect(round(plainDate('2026-10-14'), 'month').toString()).toBe('2026-10-01');
    expect(round(plainDate('2026-10-17'), 'month').toString()).toBe('2026-11-01');
    expect(round(plainDate('2026-10-16'), 'month').toString()).toBe('2026-10-01'); // 15 vs 16 days: no tie
    expect(round(plainDate('2026-04-16'), 'month').toString()).toBe('2026-05-01'); // 15 vs 15 days: tie → later
    expect(round(plainDate('2026-04-16'), 'month', { tie: 'earlier' }).toString()).toBe('2026-04-01');
    expect(ceil(plainDate('2026-10-01'), 'month').toString()).toBe('2026-10-01');
    expect(ceil(plainDate('2026-10-02'), 'month').toString()).toBe('2026-11-01');
    expect(floor(t, 'day').toString()).toBe('2026-10-09T00:00:00+03:00[Europe/Bucharest]');
    expect(() => floor(t, 'day', { increment: 2 })).toThrow(RangeError);
  });

  it('obeys floor ≤ value ≤ ceil and idempotence', () => {
    for (const day of [1, 7, 15, 16, 28, 31]) {
      const d = plainDate({ year: 2026, month: 10, day });
      const lo = floor(d, 'week');
      const hi = ceil(d, 'week');
      expect(lo.until(d).days).toBeGreaterThanOrEqual(0);
      expect(d.until(hi).days).toBeGreaterThanOrEqual(0);
      expect(floor(lo, 'week').equals(lo)).toBe(true);
      expect(ceil(hi, 'week').equals(hi)).toBe(true);
    }
  });
});

describe('diff / until / diffElapsed', () => {
  it('is to − from, truncated, anchored at from', () => {
    // Temporal: Jan 31 → Feb 28 is 0 whole months (P28D) but the fractional
    // total is exactly 1 because the constrained month step Jan 31 + 1M lands on Feb 28.
    expect(diff(plainDate('2026-01-31'), plainDate('2026-02-28'), 'month')).toBe(0);
    expect(diff(plainDate('2026-01-31'), plainDate('2026-02-28'), 'month', { fractional: true })).toBe(1);
    expect(diff(plainDate('2026-01-31'), plainDate('2026-03-01'), 'month')).toBe(1);
    expect(diff(plainDate('2026-02-28'), plainDate('2026-01-31'), 'month', { fractional: true })).toBeCloseTo(
      -28 / 31,
      10,
    );
    expect(diff(plainDate('2026-01-01'), plainDate('2026-12-31'), 'day')).toBe(364);
    expect(diff(plainDate('2026-01-01'), plainDate('2026-12-31'), 'week')).toBe(52);
    expect(diff(plainDate('2026-01-01'), plainDate('2026-12-31'), 'year')).toBe(0);
    expect(diff(plainDate('2026-01-01'), plainDate('2026-08-31'), 'quarter')).toBe(2);
    expect(diff(plainDate('2026-01-01'), plainDate('2026-08-31'), 'quarter', { fractional: true })).toBeCloseTo(
      2.656,
      2,
    );
  });

  it('uses elapsed time for time units and calendar for days on zoned values', () => {
    const a = zoned({ year: 2026, month: 3, day: 28, hour: 12 }, BUC);
    const b = add(a, { days: 1 });
    expect(diff(a, b, 'day')).toBe(1);
    expect(diff(a, b, 'hour')).toBe(23);
    expect(diffElapsed(a, b, 'day', { fractional: true })).toBeCloseTo(23 / 24, 10);
    expect(diffElapsed(instant('2026-01-01T00:00Z'), instant('2026-01-08T00:00Z'), 'week')).toBe(1);
    expect(diffElapsed(instant('2026-01-08T00:00Z'), instant('2026-01-01T00:00Z'), 'hour')).toBe(-168);
  });

  it('refuses calendar units across zones and on instants', () => {
    const a = zoned('2026-01-01T00:00:00+02:00[Europe/Bucharest]');
    const b = zoned('2026-01-02T00:00:00+00:00[Europe/London]');
    expect(() => diff(a, b, 'day')).toThrow(RangeError);
    expect(diff(a, b, 'hour')).toBe(26);
    expect(() => diff(instant('2026-01-01T00:00Z'), instant('2026-01-02T00:00Z'), 'hour')).not.toThrow();
  });

  it('until returns a balanced duration and can round', () => {
    const d = until(plainDateTime('2026-01-01T00:00'), plainDateTime('2026-03-05T04:30'), { largestUnit: 'month' });
    expect(d.toString()).toBe('P2M4DT4H30M');
    const r = until(plainDateTime('2026-01-01T00:00'), plainDateTime('2026-03-05T04:30'), {
      largestUnit: 'month',
      smallestUnit: 'day',
      roundingMode: 'halfExpand',
    });
    expect(r.toString()).toBe('P2M4D');
  });
});
