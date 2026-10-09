import { describe, expect, it } from 'vitest';

import {
  clamp,
  compareAsc,
  compareDesc,
  equals,
  isAfter,
  isBefore,
  isBetween,
  isSame,
  isSameDay,
  isSameMonth,
  isSameOrAfter,
  isSameOrBefore,
  isSameWeek,
  isSameYear,
  max,
  min,
  sameInstant,
} from './compare.js';
import { instant, plainDate, zoned } from './core.js';

const a = plainDate('2026-10-05');
const b = plainDate('2026-10-09');

describe('equality and ordering', () => {
  it('compares same-kind values and sorts', () => {
    expect(equals(a, plainDate('2026-10-05'))).toBe(true);
    expect(isBefore(a, b)).toBe(true);
    expect(isAfter(a, b)).toBe(false);
    expect(isSameOrBefore(a, a)).toBe(true);
    expect(isSameOrAfter(a, b)).toBe(false);
    expect([b, a, b].toSorted(compareAsc).map(String)).toEqual(['2026-10-05', '2026-10-09', '2026-10-09']);
    expect([a, b].toSorted(compareDesc).map(String)).toEqual(['2026-10-09', '2026-10-05']);
    expect(compareAsc(a, a)).toBe(0);
  });

  it('orders zoned values by instant but equality needs the same zone', () => {
    const buc = zoned('2026-10-09T13:00:00+03:00[Europe/Bucharest]');
    const utc = zoned('2026-10-09T10:00:00+00:00[UTC]');
    expect(compareAsc(buc, utc)).toBe(0);
    expect(equals(buc, utc)).toBe(false);
    expect(sameInstant(buc, utc)).toBe(true);
    expect(sameInstant(buc, new Date('2026-10-09T10:00:00Z'))).toBe(true);
  });

  it('refuses mixed kinds at runtime', () => {
    // @ts-expect-error — mixing kinds is a type error too
    expect(() => equals(a, instant('2026-10-05T00:00Z'))).toThrow(TypeError);
  });
});

describe('isSame*', () => {
  it('buckets by unit with ISO weeks by default', () => {
    expect(isSameDay(a, b)).toBe(false);
    expect(isSameWeek(a, b)).toBe(true); // Mon 5 … Sun 11
    expect(isSameWeek(plainDate('2026-10-04'), b)).toBe(false);
    expect(isSameMonth(a, b)).toBe(true);
    expect(isSameYear(a, plainDate('2027-01-01'))).toBe(false);
    expect(
      isSame(
        zoned('2026-10-09T15:30:00+03:00[Europe/Bucharest]'),
        zoned('2026-10-09T15:59:00+03:00[Europe/Bucharest]'),
        'hour',
      ),
    ).toBe(true);
  });

  it('needs an explicit zone for instants and cross-zone values', () => {
    const i1 = instant('2026-10-09T22:30:00Z');
    const i2 = instant('2026-10-10T01:30:00Z');
    expect(() => isSame(i1, i2, 'day')).toThrow(TypeError);
    expect(isSame(i1, i2, 'day', { timeZone: 'Europe/Bucharest' })).toBe(true);
    expect(isSame(i1, i2, 'day', { timeZone: 'UTC' })).toBe(false);
    const buc = zoned(i1, 'Europe/Bucharest');
    const ny = zoned(i2, 'America/New_York');
    expect(() => isSameDay(buc, ny)).toThrow(TypeError);
    expect(isSameDay(buc, ny, { timeZone: 'Europe/Bucharest' })).toBe(true);
  });
});

describe('isBetween / min / max / clamp', () => {
  it('defaults to [start, end) and honours other bounds', () => {
    expect(isBetween(a, a, b)).toBe(true);
    expect(isBetween(b, a, b)).toBe(false);
    expect(isBetween(b, a, b, { bounds: '[]' })).toBe(true);
    expect(isBetween(a, a, b, { bounds: '(]' })).toBe(false);
    expect(() => isBetween(a, b, a)).toThrow(RangeError);
  });

  it('picks extremes and clamps to inputs', () => {
    const c = plainDate('2026-01-01');
    expect(min([a, b, c])).toBe(c);
    expect(max([a, b, c])).toBe(b);
    expect(clamp(c, a, b)).toBe(a);
    expect(clamp(plainDate('2026-12-31'), a, b)).toBe(b);
    expect(clamp(plainDate('2026-10-07'), a, b).toString()).toBe('2026-10-07');
    expect(() => clamp(a, b, a)).toThrow(RangeError);
  });
});
