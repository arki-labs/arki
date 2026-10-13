/**
 * Timestamp assertions
 *
 * Apps moved their timestamp columns from `Date` to `@arki/date` Temporal
 * values. A helper that only knows `Date` fails on every such row, so these
 * tests pin both kinds, and the type of the value after the assertion.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Instant, ZonedDateTime } from '@arki/date/types';
import { instant, zoned } from '@arki/date';

import type { Timestamp, Timestamps } from './timestamps';
import { assertTimestamps, assertUpdatedAfterCreated } from './timestamps';

const early = '2026-03-04T05:06:07.123456789Z';
const late = '2026-03-04T05:06:07.123456790Z';

describe('assertTimestamps', () => {
  it('accepts Date timestamps', () => {
    expect(() => assertTimestamps({ createdAt: new Date(0), updatedAt: new Date(1) })).not.toThrow();
  });

  it('accepts Instant timestamps', () => {
    expect(() => assertTimestamps({ createdAt: instant(early), updatedAt: instant(late) })).not.toThrow();
  });

  it('accepts ZonedDateTime timestamps and a mix of kinds', () => {
    const zonedAt = zoned(early, 'Europe/Bucharest');

    expect(() => assertTimestamps({ createdAt: zonedAt, updatedAt: new Date(0) })).not.toThrow();
  });

  it('rejects values that are not moments', () => {
    expect(() => assertTimestamps(null)).toThrow('Expected object with timestamps');
    expect(() => assertTimestamps({ updatedAt: new Date(0) })).toThrow(/createdAt .* got undefined/);
    expect(() => assertTimestamps({ createdAt: new Date(0), updatedAt: '2026-03-04T00:00:00Z' })).toThrow(
      /updatedAt .* got string/,
    );
    expect(() => assertTimestamps({ createdAt: new Date(Number.NaN), updatedAt: new Date(0) })).toThrow(
      /createdAt .* invalid Date/,
    );
  });

  it('narrows the value to Timestamps, keeping the type its fields already had', () => {
    const row: unknown = { createdAt: instant(early), updatedAt: instant(late) };
    assertTimestamps(row);
    expectTypeOf(row).toEqualTypeOf<Timestamps>();

    const typed: { createdAt: Instant; updatedAt: Instant; name: string } = {
      createdAt: instant(early),
      updatedAt: instant(late),
      name: 'x',
    };
    assertTimestamps(typed);
    expectTypeOf(typed.createdAt).toEqualTypeOf<Instant>();
    expectTypeOf(typed.name).toBeString();
  });
});

describe('assertUpdatedAfterCreated', () => {
  it('accepts updatedAt equal to or after createdAt, for Date', () => {
    expect(() => assertUpdatedAfterCreated({ createdAt: new Date(5), updatedAt: new Date(5) })).not.toThrow();
    expect(() => assertUpdatedAfterCreated({ createdAt: new Date(5), updatedAt: new Date(6) })).not.toThrow();
  });

  it('rejects updatedAt before createdAt, for Date', () => {
    expect(() => assertUpdatedAfterCreated({ createdAt: new Date(6), updatedAt: new Date(5) })).toThrow(
      /Expected updatedAt .* to be >= createdAt/,
    );
  });

  it('accepts and rejects Instant timestamps', () => {
    expect(() => assertUpdatedAfterCreated({ createdAt: instant(early), updatedAt: instant(early) })).not.toThrow();
    expect(() => assertUpdatedAfterCreated({ createdAt: instant(early), updatedAt: instant(late) })).not.toThrow();
    expect(() => assertUpdatedAfterCreated({ createdAt: instant(late), updatedAt: instant(early) })).toThrow(
      /Expected updatedAt \(2026-03-04T05:06:07\.123456789Z\) to be >= createdAt \(2026-03-04T05:06:07\.12345679Z\)/,
    );
  });

  it('compares nanoseconds, which a Date cannot tell apart', () => {
    // 100 ns apart: the same millisecond, so reading both as Date would call them equal.
    expect(() => assertUpdatedAfterCreated({ createdAt: instant(late), updatedAt: instant(early) })).toThrow();
  });

  it('compares ZonedDateTime by the exact moment, not the wall clock', () => {
    // 10:00 in Bucharest (UTC+3 in summer) is 07:00Z, which is before 08:00Z.
    const bucharest = zoned('2026-07-01T07:00:00Z', 'Europe/Bucharest');
    const laterUtc = zoned('2026-07-01T08:00:00Z', 'UTC');

    expect(() => assertUpdatedAfterCreated({ createdAt: bucharest, updatedAt: laterUtc })).not.toThrow();
    expect(() => assertUpdatedAfterCreated({ createdAt: laterUtc, updatedAt: bucharest })).toThrow();
  });

  it('compares across kinds', () => {
    const at = '2026-07-01T07:00:00Z';

    expect(() =>
      assertUpdatedAfterCreated({ createdAt: new Date(at), updatedAt: instant('2026-07-01T07:00:00.001Z') }),
    ).not.toThrow();
    expect(() => assertUpdatedAfterCreated({ createdAt: instant(at), updatedAt: new Date('2026-07-01T06:59:59Z') })).toThrow();
  });

  it('accepts exactly the Timestamp kinds', () => {
    expectTypeOf<Parameters<typeof assertUpdatedAfterCreated>[0]>().toEqualTypeOf<Timestamps>();
    expectTypeOf<Timestamp>().toEqualTypeOf<Date | Instant | ZonedDateTime>();
    expectTypeOf<Timestamps['createdAt']>().toEqualTypeOf<Timestamp>();
  });
});
