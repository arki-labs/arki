/**
 * Timestamp recency and generated date ranges
 *
 * Apps hold timestamps as `Date` or as `@arki/date` Temporal values. A helper
 * that only knows `Date` fails on every row of an app that moved to Temporal,
 * so each kind is pinned here, and the type of the value after the assertion.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Instant, ZonedDateTime } from '@arki/date/types';
import { instant, zoned } from '@arki/date';

import type { Timestamp } from './timestamps';
import { assertTimestampRecent } from './assertions';
import { epochMilliseconds } from './timestamps';

function secondsAgo(seconds: number): Date {
  return new Date(Date.now() - seconds * 1000);
}

describe('assertTimestampRecent', () => {
  it('accepts a recent Date', () => {
    expect(() => assertTimestampRecent(new Date())).not.toThrow();
  });

  it('accepts a recent Instant', () => {
    expect(() => assertTimestampRecent(instant(new Date()))).not.toThrow();
  });

  it('accepts a recent ZonedDateTime, whatever its zone', () => {
    expect(() => assertTimestampRecent(zoned(new Date().toISOString(), 'Pacific/Auckland'))).not.toThrow();
  });

  it.each([
    ['Date', (): Date => secondsAgo(60)],
    ['Instant', (): Instant => instant(secondsAgo(60))],
    ['ZonedDateTime', (): ZonedDateTime => zoned(secondsAgo(60).toISOString(), 'Europe/Bucharest')],
  ])('rejects an old %s', (_kind, make) => {
    expect(() => assertTimestampRecent(make())).toThrow(/within 10 seconds of now/);
  });

  it('honours withinSeconds for every kind, and a timestamp in the future counts as distance', () => {
    const options = { withinSeconds: 120 };

    expect(() => assertTimestampRecent(secondsAgo(60), options)).not.toThrow();
    expect(() => assertTimestampRecent(instant(secondsAgo(60)), options)).not.toThrow();
    expect(() => assertTimestampRecent(secondsAgo(-60), options)).not.toThrow();
    expect(() => assertTimestampRecent(instant(secondsAgo(-60)))).toThrow(/within 10 seconds of now/);
  });

  it('puts the label in the error', () => {
    expect(() => assertTimestampRecent(secondsAgo(60), { label: 'createdAt' })).toThrow(/Expected createdAt/);
  });

  it.each([
    ['a string', '2026-03-04T05:06:07Z'],
    ['a number', Date.now()],
    ['null', null],
    ['an invalid Date', new Date(Number.NaN)],
  ])('rejects %s', (_kind, value) => {
    expect(() => assertTimestampRecent(value)).toThrow(/to be a Date, Instant or ZonedDateTime/);
  });

  it('narrows the value to Timestamp', () => {
    const value: unknown = new Date();
    assertTimestampRecent(value);

    expectTypeOf(value).toEqualTypeOf<Timestamp>();
  });
});

describe('epochMilliseconds', () => {
  it('reads every kind to the same millisecond', () => {
    const iso = '2026-03-04T05:06:07.123456789Z';
    const expected = Date.parse('2026-03-04T05:06:07.123Z');

    expect(epochMilliseconds(new Date(expected))).toBe(expected);
    expect(epochMilliseconds(instant(iso))).toBe(expected);
    expect(epochMilliseconds(zoned(iso, 'Asia/Tokyo'))).toBe(expected);
  });

  it('rounds toward the past before 1970', () => {
    expect(epochMilliseconds(instant('1969-12-31T23:59:59.999500000Z'))).toBe(-1);
  });
});
