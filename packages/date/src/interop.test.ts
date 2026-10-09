import { describe, expect, it } from 'vitest';

import { instant, plainDate, zoned } from './core.js';
import { fromDate, fromPickerDate, systemTimeZone, toDate, toPickerDate } from './interop.js';

describe('fromDate / toDate', () => {
  it('keeps the instant and returns a fresh mutable Date', () => {
    const source = new Date('2026-05-20T10:00:00.123Z');
    const i = fromDate(source);
    expect(i.toString()).toBe('2026-05-20T10:00:00.123Z');
    source.setFullYear(2000);
    expect(i.toString()).toBe('2026-05-20T10:00:00.123Z');
    const out = toDate(i);
    out.setFullYear(1999);
    expect(toDate(i).getUTCFullYear()).toBe(2026);
    expect(toDate(zoned('2026-05-20T13:00:00+03:00[Europe/Bucharest]')).toISOString()).toBe('2026-05-20T10:00:00.000Z');
  });

  it('truncates sub-millisecond precision instead of throwing', () => {
    expect(toDate(instant('2026-05-20T10:00:00.123456789Z')).toISOString()).toBe('2026-05-20T10:00:00.123Z');
  });
});

describe('fromPickerDate / toPickerDate', () => {
  it('reads the calendar fields a picker showed, in its basis', () => {
    const local = new Date(2026, 0, 31, 0, 0, 0);
    expect(fromPickerDate(local).toString()).toBe('2026-01-31');
    expect(fromPickerDate(new Date(Date.UTC(2026, 0, 31)), { basis: 'utc' }).toString()).toBe('2026-01-31');
    const lateEvening = new Date('2026-01-31T23:30:00Z');
    expect(fromPickerDate(lateEvening, { basis: 'zone', timeZone: 'Europe/Bucharest' }).toString()).toBe('2026-02-01');
    expect(fromPickerDate(lateEvening, { basis: 'zone', timeZone: 'America/New_York' }).toString()).toBe('2026-01-31');
  });

  it('round-trips through the picker basis and rejects invalid dates', () => {
    const d = plainDate('2026-02-28');
    expect(fromPickerDate(toPickerDate(d)).equals(d)).toBe(true);
    expect(toPickerDate(d, { basis: 'utc' }).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(toPickerDate(plainDate('0050-01-01')).getFullYear()).toBe(50);
    expect(() => fromPickerDate(new Date(Number.NaN))).toThrow(RangeError);
    // Samoa skipped 2011-12-30 entirely
    expect(() => toPickerDate(plainDate('2011-12-30'), { basis: 'zone', timeZone: 'Pacific/Apia' })).toThrow(
      RangeError,
    );
  });
});

describe('systemTimeZone', () => {
  it('returns an IANA id the runtime accepts', () => {
    expect(() => zoned(instant('2026-01-01T00:00Z'), systemTimeZone())).not.toThrow();
  });
});
