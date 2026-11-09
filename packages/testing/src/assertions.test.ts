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
import { FAILURE_ERROR_CODES } from '@arki/failure';

import type { PaginatedResponse } from './assertions';
import type { Timestamp } from './timestamps';
import { assertArraySorted, assertDeepPartialMatch, assertPaginationValid, assertTimestampRecent } from './assertions';
import { epochMilliseconds, epochNanoseconds } from './timestamps';

const invariantBroken = expect.objectContaining({ code: FAILURE_ERROR_CODES.invariant });

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

// Why (audit-3 #9): BigInt(NaN) threw a raw RangeError from deep inside the helper. An Invalid Date holds no
// moment, so reading its epoch is a caller bug: the documented invariant failure, with the reason.
describe('an Invalid Date has no epoch', () => {
  it('epochNanoseconds and epochMilliseconds throw the invariant failure, not a RangeError', () => {
    expect(() => epochNanoseconds(new Date(Number.NaN))).toThrow(invariantBroken);
    expect(() => epochMilliseconds(new Date('not a date'))).toThrow(/Invalid Date/);
  });
});

// Why: `diffSeconds > NaN` is never true, so a NaN window let every timestamp pass the assertion.
describe('assertTimestampRecent withinSeconds', () => {
  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    'withinSeconds %s throws the invariant failure',
    withinSeconds => {
      expect(() => assertTimestampRecent(new Date(), { withinSeconds })).toThrow(invariantBroken);
    },
  );

  it('a window of 0 is allowed, and refuses a timestamp 1000 s away', () => {
    expect(() => assertTimestampRecent(new Date(Date.now() + 1_000_000), { withinSeconds: 0 })).toThrow(
      /within 0 seconds/,
    );
  });
});

// Why (A-39): the page shape is checked by a schema, so the type it narrows to is the one it checked.
describe('assertPaginationValid shape', () => {
  it('refuses a non-object, an items that is not an array, and fields of the wrong type', () => {
    expect(() => assertPaginationValid(null)).toThrow('Expected paginated response to be an object');
    expect(() => assertPaginationValid([])).toThrow('Expected paginated response to be an object');
    expect(() => assertPaginationValid({ items: 'x' })).toThrow(/to have an items array/);
    expect(() => assertPaginationValid({ items: [], total: '3' })).toThrow(/to have an items array: .*total/);
    expect(() => assertPaginationValid({ items: [], nextCursor: 4 })).toThrow(/nextCursor/);
  });

  it('checks total and hasMore against the options, and narrows to PaginatedResponse', () => {
    const response: unknown = { items: [1, 2], total: 2, nextCursor: null, hasMore: false };
    assertPaginationValid(response, { itemsCount: 2, total: 2, hasMore: false });
    expectTypeOf(response).toEqualTypeOf<PaginatedResponse>();
    expect(() => assertPaginationValid({ items: [] }, { total: 0 })).toThrow(
      'Expected total to be a number, got undefined',
    );
    expect(() => assertPaginationValid({ items: [], hasMore: true }, { hasMore: false })).toThrow(
      /hasMore to be false/,
    );
  });
});

describe('assertDeepPartialMatch walks objects and arrays', () => {
  // Why: the mismatch message used JSON.stringify, so a bigint column (or a cycle) turned the path-naming
  // assertion into a bare TypeError that hid which field differed.
  it('names the differing path for a bigint or circular value instead of a TypeError from JSON.stringify', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => assertDeepPartialMatch({ count: 2n }, { count: 1n })).toThrow(
      'Expected object.count to be "1n", got "2n"',
    );
    expect(() => assertDeepPartialMatch({ owner: circular }, { owner: null })).toThrow(
      'Expected object.owner to be null, got [object Object]',
    );
  });

  it('matches nested objects and array entries, and reports the path of a miss', () => {
    expect(() => assertDeepPartialMatch({ a: { b: 1, c: 2 }, list: [1] }, { a: { b: 1 } })).not.toThrow();
    expect(() => assertDeepPartialMatch([{ id: 1 }], [{ id: 1 }])).not.toThrow();
    expect(() => assertDeepPartialMatch({ a: 'x' }, { a: { b: 1 } })).toThrow("Expected object to have property 'a.b'");
    expect(() => assertDeepPartialMatch({ a: { b: 2 } }, { a: { b: 1 } })).toThrow(
      'Expected object.a.b to be 1, got 2',
    );
  });
});

// Why: `NaN - x` is NaN and `NaN > 0` is false, so an unsortable key passed the sort assertion silently.
describe('assertArraySorted keys', () => {
  it('orders numbers with infinities, bigints, strings and dates', () => {
    expect(() => assertArraySorted([{ k: -Infinity }, { k: 1 }, { k: Infinity }, { k: Infinity }], 'k')).not.toThrow();
    expect(() => assertArraySorted([{ k: 2n }, { k: 1n }], 'k', 'desc')).not.toThrow();
    expect(() => assertArraySorted([{ k: 'b' }, { k: 'a' }], 'k')).toThrow(/ascending/);
    expect(() => assertArraySorted([{ k: new Date(1) }, { k: new Date(2) }], 'k')).not.toThrow();
  });

  it('refuses NaN, an Invalid Date and a mix of kinds', () => {
    expect(() => assertArraySorted([{ k: 1 }, { k: Number.NaN }], 'k')).toThrow(/Cannot compare values of 'k'/);
    expect(() => assertArraySorted([{ k: new Date(1) }, { k: new Date(Number.NaN) }], 'k')).toThrow(/Cannot compare/);
    expect(() => assertArraySorted<{ k: unknown }>([{ k: 1 }, { k: '2' }], 'k')).toThrow(/got number and string/);
  });
});
