import { describe, expect, it } from 'vitest';

import {
  fromMillis,
  fromUnix,
  instant,
  plainDate,
  plainDateTime,
  toISO,
  toMillis,
  toPlainDate,
  toUnix,
  tryParse,
  zoned,
} from './core.js';
import { isInstant, isPlainDate, isPoint, isZonedDateTime, kindOf } from './types.js';

describe('plainDate', () => {
  it('accepts date-only strings, parts and civil values', () => {
    expect(plainDate('2026-05-20').toString()).toBe('2026-05-20');
    expect(plainDate({ year: 2026, month: 5, day: 20 }).toString()).toBe('2026-05-20');
    expect(plainDate(zoned('2026-05-20T23:30:00+03:00[Europe/Bucharest]')).toString()).toBe('2026-05-20');
    expect(plainDate(plainDateTime('2026-05-20T01:00')).toString()).toBe('2026-05-20');
  });

  it('rejects timestamps so a time and zone are never dropped silently', () => {
    expect(() => plainDate('2026-05-20T10:00:00Z')).toThrow(/date-only/);
    expect(() => plainDate({ year: 2026, month: 2, day: 30 })).toThrow(RangeError);
    expect(() => plainDate('2026-13-01')).toThrow(RangeError);
  });
});

describe('plainDateTime', () => {
  it('accepts zone-less strings and parts, rejects offsets', () => {
    expect(plainDateTime('2026-05-20T10:30').toString()).toBe('2026-05-20T10:30:00');
    expect(plainDateTime({ year: 2026, month: 5, day: 20, hour: 9 }).toString()).toBe('2026-05-20T09:00:00');
    expect(() => plainDateTime('2026-05-20T10:30Z')).toThrow(/zone-less/);
    expect(() => plainDateTime('2026-05-20T10:30+02:00')).toThrow(/zone-less/);
  });
});

describe('instant', () => {
  it('requires an offset in strings and copies Dates by epoch', () => {
    expect(instant('2026-05-20T10:00:00Z').toString()).toBe('2026-05-20T10:00:00Z');
    expect(instant('2026-05-20T13:00:00+03:00').toString()).toBe('2026-05-20T10:00:00Z');
    expect(instant(new Date(0)).epochMilliseconds).toBe(0);
    expect(() => instant('2026-05-20T10:00:00')).toThrow(RangeError);
    expect(() => instant(new Date(Number.NaN))).toThrow(/invalid Date/);
  });
});

describe('zoned', () => {
  it('builds from annotated strings, parts, plain values, instants and Dates', () => {
    expect(zoned('2026-05-20T10:00:00+03:00[Europe/Bucharest]').timeZoneId).toBe('Europe/Bucharest');
    expect(zoned({ year: 2026, month: 5, day: 20, hour: 10 }, 'Europe/Bucharest').toString()).toBe(
      '2026-05-20T10:00:00+03:00[Europe/Bucharest]',
    );
    expect(zoned(plainDate('2026-05-20'), 'Europe/Bucharest').toString()).toBe(
      '2026-05-20T00:00:00+03:00[Europe/Bucharest]',
    );
    expect(zoned(instant('2026-05-20T10:00:00Z'), 'Europe/Bucharest').hour).toBe(13);
    expect(zoned(new Date('2026-05-20T10:00:00Z'), 'UTC').hour).toBe(10);
    expect(zoned(plainDateTime('2026-05-20T10:00'), 'America/New_York').offset).toBe('-04:00');
  });

  it('rejects strings without a zone annotation and parts without a zone', () => {
    expect(() => zoned('2026-05-20T10:00:00+03:00')).toThrow(/annotation/);
    // @ts-expect-error — parts need a zone
    expect(() => zoned({ year: 2026, month: 5, day: 20 })).toThrow(TypeError);
  });

  it('resolves DST gaps and folds with the compatible rule by default, and can reject', () => {
    const gap = { year: 2026, month: 3, day: 29, hour: 3, minute: 30 }; // 03:00–04:00 skipped in Bucharest
    expect(zoned(gap, 'Europe/Bucharest').toString()).toBe('2026-03-29T04:30:00+03:00[Europe/Bucharest]');
    expect(zoned(gap, 'Europe/Bucharest', { disambiguation: 'earlier' }).toString()).toBe(
      '2026-03-29T02:30:00+02:00[Europe/Bucharest]',
    );
    expect(() => zoned(gap, 'Europe/Bucharest', { disambiguation: 'reject' })).toThrow(RangeError);
    const fold = { year: 2026, month: 10, day: 25, hour: 3, minute: 30 }; // 03:00–04:00 repeats
    expect(zoned(fold, 'Europe/Bucharest').offset).toBe('+03:00');
    expect(zoned(fold, 'Europe/Bucharest', { disambiguation: 'later' }).offset).toBe('+02:00');
  });
});

describe('unix / millis / iso', () => {
  it('round-trips seconds and milliseconds', () => {
    expect(fromUnix(1_700_000_000).toString()).toBe('2023-11-14T22:13:20Z');
    expect(fromUnix(1.5).epochNanoseconds).toBe(1_500_000_000n);
    expect(toUnix(fromMillis(1_700_000_000_999))).toBe(1_700_000_000);
    expect(toUnix(fromMillis(-1))).toBe(-1);
    expect(toMillis(zoned('1970-01-01T02:00:00+02:00[Europe/Bucharest]'))).toBe(0);
    expect(() => fromMillis(1.5)).toThrow(RangeError);
    expect(() => fromUnix(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(toISO(plainDate('2026-05-20'))).toBe('2026-05-20');
    expect(toPlainDate(zoned('2026-05-20T23:30:00-07:00[America/Los_Angeles]')).toString()).toBe('2026-05-20');
  });
});

describe('tryParse', () => {
  it('returns ok/err without throwing and never reinterprets a kind', () => {
    const ok = tryParse('2026-05-20', 'plainDate');
    expect(ok.ok && ok.value.toString()).toBe('2026-05-20');
    const bad = tryParse('2026-05-20', 'instant');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toBeInstanceOf(RangeError);
    const dur = tryParse('P1DT2H', 'duration');
    expect(dur.ok && dur.value.hours).toBe(2);
    expect(tryParse('nonsense', 'zoned').ok).toBe(false);
  });
});

describe('guards', () => {
  it('identify kinds', () => {
    expect(isPlainDate(plainDate('2026-01-01'))).toBe(true);
    expect(isInstant(instant('2026-01-01T00:00Z'))).toBe(true);
    expect(isZonedDateTime(zoned('2026-01-01T00:00Z[UTC]'))).toBe(true);
    expect(isPoint(new Date())).toBe(false);
    expect(isPoint('2026-01-01')).toBe(false);
    expect(kindOf(plainDateTime('2026-01-01T00:00'))).toBe('plainDateTime');
  });
});
