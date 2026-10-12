import { parse as fnsParse } from 'date-fns/parse';
import { describe, expect, it } from 'vitest';

import { plainDate, plainDateTime, zoned } from './core.js';
import { format } from './format.js';
import { parseDate, parseDateTime, parseZoned, tryParseDate, tryParseDateTime, tryParseZoned } from './parse.js';

const BUCHAREST = 'Europe/Bucharest';

describe('parseDate — token groups', () => {
  it('reads every year width', () => {
    expect(parseDate('2026-3-5', 'y-M-d').toString()).toBe('2026-03-05');
    expect(parseDate('+2026-3-5', 'y-M-d').toString()).toBe('2026-03-05');
    expect(parseDate('-0044-3-15', 'y-M-d').toString()).toBe('-000044-03-15');
    expect(parseDate('26-3-5', 'yy-M-d').toString()).toBe('2026-03-05');
    expect(parseDate('99-3-5', 'yy-M-d').toString()).toBe('2099-03-05');
    expect(parseDate('987-3-5', 'yyy-M-d').toString()).toBe('0987-03-05');
    expect(parseDate('20260305', 'yyyyMMdd').toString()).toBe('2026-03-05');
  });

  it('reads numeric months and days: single letters take 1-2 digits, doubled exactly 2', () => {
    expect(parseDate('5/3/2026', 'd/M/yyyy').toString()).toBe('2026-03-05');
    expect(parseDate('15/12/2026', 'd/M/yyyy').toString()).toBe('2026-12-15');
    expect(parseDate('05/03/2026', 'dd/MM/yyyy').toString()).toBe('2026-03-05');
    expect(() => parseDate('5/03/2026', 'dd/MM/yyyy')).toThrow(/expected a 2-digit day for "dd" at position 0/);
  });

  it('reads month names case-insensitively, format and stand-alone', () => {
    expect(parseDate('Mar 5, 2026', 'MMM d, yyyy').toString()).toBe('2026-03-05');
    expect(parseDate('march 5, 2026', 'MMMM d, yyyy').toString()).toBe('2026-03-05');
    expect(parseDate('SEPTEMBER 2026 1', 'LLLL yyyy d').toString()).toBe('2026-09-01');
    expect(parseDate('Sep 1 2026', 'LLL d yyyy').toString()).toBe('2026-09-01');
  });

  it('uses the locale words that format prints', () => {
    expect(parseDate('5 martie 2026', 'd MMMM yyyy', { locale: 'ro-RO' }).toString()).toBe('2026-03-05');
    expect(parseDate('Donnerstag, 5. März 2026', 'EEEE, d. MMMM yyyy', { locale: 'de-DE' }).toString()).toBe(
      '2026-03-05',
    );
  });

  it('reads a day of year without month or day tokens', () => {
    expect(parseDate('2024-60', 'yyyy-D').toString()).toBe('2024-02-29');
    expect(parseDate('2026-365', 'yyyy-DDD').toString()).toBe('2026-12-31');
    expect(() => parseDate('2026-366', 'yyyy-DDD')).toThrow(/day of year 366 is out of range for 2026/);
    expect(() => parseDate('2026-60-3', 'yyyy-D-M')).toThrow(/mixes day of year/);
  });

  it('validates the weekday against the date', () => {
    expect(parseDate('Thu, 5 Mar 2026', 'EEE, d MMM yyyy').toString()).toBe('2026-03-05');
    expect(parseDate('Thursday 2026-03-05', 'EEEE yyyy-MM-dd').toString()).toBe('2026-03-05');
    expect(parseDate('4 2026-03-05', 'i yyyy-MM-dd').toString()).toBe('2026-03-05');
    expect(parseDate('thursday 2026-03-05', 'iiii yyyy-MM-dd').toString()).toBe('2026-03-05');
    expect(() => parseDate('Fri, 5 Mar 2026', 'EEE, d MMM yyyy')).toThrow(
      /parseDate: weekday 5 does not match 2026-03-05/,
    );
  });

  it('reads and validates time tokens, then drops them', () => {
    expect(parseDate('2026-03-05 23:59', 'yyyy-MM-dd HH:mm').toString()).toBe('2026-03-05');
    expect(() => parseDate('2026-03-05 24:00', 'yyyy-MM-dd HH:mm')).toThrow(/parseDate: time 24:00:00 is invalid/);
  });

  it('matches quoted literals and escaped quotes', () => {
    expect(parseDate("2026 'Q' 03 at 05", "yyyy '''Q''' MM 'at' dd").toString()).toBe('2026-03-05');
  });
});

function at(text: string, pattern: string): string {
  return parseDateTime(`2026-03-05 ${text}`, `yyyy-MM-dd ${pattern}`).toString();
}

describe('parseDateTime — token groups', () => {
  it('fills missing time fields with zero', () => {
    expect(parseDateTime('2026-03-05', 'yyyy-MM-dd').toString()).toBe('2026-03-05T00:00:00');
    expect(parseDateTime('2026-03-05 7', 'yyyy-MM-dd H').toString()).toBe('2026-03-05T07:00:00');
  });

  it('reads 12-hour clocks with every AM/PM width', () => {
    expect(at('12:30 AM', 'h:mm a')).toBe('2026-03-05T00:30:00');
    expect(at('12:30 PM', 'hh:mm aa')).toBe('2026-03-05T12:30:00');
    expect(at('9:05 pm', 'h:mm aaa')).toBe('2026-03-05T21:05:00');
    expect(at('9:05 a.m.', 'h:mm aaaa')).toBe('2026-03-05T09:05:00');
    expect(at('0:15 PM', 'K:mm a')).toBe('2026-03-05T12:15:00');
    expect(at('11:15 PM', 'KK:mm a')).toBe('2026-03-05T23:15:00');
    expect(() => at('13:00 PM', 'h:mm a')).toThrow(/hour 13 is out of range for "h"/);
  });

  it('reads k as 1-24 with 24 meaning midnight', () => {
    expect(parseDateTime('2026-03-05 24:00', 'yyyy-MM-dd kk:mm').toString()).toBe('2026-03-05T00:00:00');
    expect(parseDateTime('2026-03-05 1:00', 'yyyy-MM-dd k:mm').toString()).toBe('2026-03-05T01:00:00');
  });

  it('right-pads fractions to nanoseconds', () => {
    expect(parseDateTime('2026-03-05 10:00:00.5', 'yyyy-MM-dd HH:mm:ss.S').toString()).toBe('2026-03-05T10:00:00.5');
    expect(parseDateTime('2026-03-05 10:00:00.12', 'yyyy-MM-dd HH:mm:ss.SS').millisecond).toBe(120);
    expect(parseDateTime('2026-03-05 10:00:00.123456789', 'yyyy-MM-dd HH:mm:ss.SSSSSSSSS').nanosecond).toBe(789);
  });

  it('refuses tokens that disagree', () => {
    expect(() => parseDateTime('2026-03-05 13 02 PM', 'yyyy-MM-dd HH hh a')).toThrow(/disagree/);
    expect(() => parseDateTime('2026-03-05 2027', 'yyyy-MM-dd yyyy')).toThrow(/conflicts with 2026/);
  });
});

describe('errors', () => {
  it('reports leftover text with its position', () => {
    expect(() => parseDate('2026-03-05 extra', 'yyyy-MM-dd')).toThrow(
      'parseDate: unexpected text " extra" at position 10 of "2026-03-05 extra" (pattern "yyyy-MM-dd")',
    );
  });

  it('reports missing text with what was expected', () => {
    expect(() => parseDate('2026-03', 'yyyy-MM-dd')).toThrow(/parseDate: expected "-" at position 7/);
    expect(() => parseDateTime('2026-03-05 10:', 'yyyy-MM-dd HH:mm')).toThrow(
      /parseDateTime: expected a 2-digit minute for "mm" at position 14/,
    );
  });

  it('rejects an unknown month name', () => {
    expect(() => parseDate('Mrz 5, 2026', 'MMM d, yyyy')).toThrow(/expected a month name for "MMM" at position 0/);
  });

  it('rejects impossible dates and times instead of clamping', () => {
    expect(() => parseDate('2026-02-30', 'yyyy-MM-dd')).toThrow('parseDate: date 2026-02-30 is invalid');
    expect(() => parseDate('2026-13-01', 'yyyy-MM-dd')).toThrow(/is invalid/);
    expect(() => parseDateTime('2026-03-05 10:60', 'yyyy-MM-dd HH:mm')).toThrow(/time 10:60:00 is invalid/);
    expect(() => parseDateTime('2026-03-05 24:00', 'yyyy-MM-dd HH:mm')).toThrow(RangeError);
  });

  it('rejects unsupported tokens, naming the function', () => {
    expect(() => parseDate('Q1 2026', 'qqq yyyy')).toThrow('parseDate: unsupported pattern token "qqq"');
    expect(() => parseDate('2026-03-5th', 'yyyy-MM-do')).toThrow('parseDate: unsupported pattern token "do"');
    expect(() => parseDateTime('x', 'P')).toThrow('parseDateTime: unsupported pattern token "P"');
  });

  it('rejects incomplete patterns and 12-hour tokens without AM/PM', () => {
    expect(() => parseDate('03-05', 'MM-dd')).toThrow(/has no year token/);
    expect(() => parseDate('2026-05', 'yyyy-dd')).toThrow(/has no month token/);
    expect(() => parseDateTime('2026-03-05 9:30', 'yyyy-MM-dd h:mm')).toThrow(/without an AM\/PM token/);
  });

  it('refuses offsets outside parseZoned', () => {
    expect(() => parseDateTime('2026-03-05 10:00Z', 'yyyy-MM-dd HH:mmX')).toThrow(/use parseZoned/);
    expect(() => parseDate('2026-03-05+02', 'yyyy-MM-ddx')).toThrow(/use parseZoned/);
  });

  it('tryParse returns undefined for bad text but still throws for a bad pattern', () => {
    expect(tryParseDate('2026-02-30', 'yyyy-MM-dd')).toBeUndefined();
    expect(tryParseDate('2026-03-05', 'yyyy-MM-dd')?.toString()).toBe('2026-03-05');
    expect(tryParseDateTime('2026-03-05 25:00', 'yyyy-MM-dd HH:mm')).toBeUndefined();
    expect(tryParseZoned('nope', 'yyyy-MM-dd', BUCHAREST)).toBeUndefined();
    expect(() => tryParseDate('2026', 'qqq')).toThrow(/unsupported pattern token/);
    expect(() => tryParseZoned('2026-03-05', 'yyyy-MM-dd', 'Mars/Olympus')).toThrow(/unknown time zone/);
  });
});

describe('parseZoned', () => {
  const pattern = 'yyyy-MM-dd HH:mm';

  it('resolves a skipped wall time (spring forward 03:00 → 04:00) with the disambiguation rule', () => {
    expect(parseZoned('2026-03-29 03:30', pattern, BUCHAREST).toString()).toBe(
      '2026-03-29T04:30:00+03:00[Europe/Bucharest]',
    );
    expect(parseZoned('2026-03-29 03:30', pattern, BUCHAREST, { disambiguation: 'earlier' }).toString()).toBe(
      '2026-03-29T02:30:00+02:00[Europe/Bucharest]',
    );
    expect(() => parseZoned('2026-03-29 03:30', pattern, BUCHAREST, { disambiguation: 'reject' })).toThrow(
      /parseZoned: wall time 2026-03-29T03:30:00 in Europe\/Bucharest is invalid/,
    );
    expect(tryParseZoned('2026-03-29 03:30', pattern, BUCHAREST, { disambiguation: 'reject' })).toBeUndefined();
  });

  it('resolves a repeated wall time (fall back 04:00 → 03:00) with the disambiguation rule', () => {
    expect(parseZoned('2026-10-25 03:30', pattern, BUCHAREST).offset).toBe('+03:00');
    expect(parseZoned('2026-10-25 03:30', pattern, BUCHAREST, { disambiguation: 'later' }).offset).toBe('+02:00');
  });

  it('takes the exact instant from an offset token and shows it in the zone', () => {
    expect(parseZoned('2026-10-25 03:30 +02:00', 'yyyy-MM-dd HH:mm XXX', BUCHAREST).toString()).toBe(
      '2026-10-25T03:30:00+02:00[Europe/Bucharest]',
    );
    expect(parseZoned('2026-03-29 01:00Z', 'yyyy-MM-dd HH:mmX', BUCHAREST).toString()).toBe(
      '2026-03-29T04:00:00+03:00[Europe/Bucharest]',
    );
    expect(parseZoned('2026-03-29 01:00 -0530', 'yyyy-MM-dd HH:mm xx', 'UTC').toString()).toBe(
      '2026-03-29T06:30:00+00:00[UTC]',
    );
    expect(parseZoned('2026-03-29 01:00 +05', 'yyyy-MM-dd HH:mm x', 'UTC').toString()).toBe(
      '2026-03-28T20:00:00+00:00[UTC]',
    );
    expect(() => parseZoned('2026-03-29 01:00 Z', 'yyyy-MM-dd HH:mm xxx', 'UTC')).toThrow(/an offset like \+02:00/);
    expect(() => parseZoned('2026-03-29 01:00 +24:00', 'yyyy-MM-dd HH:mm XXX', 'UTC')).toThrow(/out of range/);
  });
});

describe('round trip: parse(format(value, pattern), pattern) returns value', () => {
  const dates = ['2026-03-01', '2024-02-29', '2000-12-31', '2099-07-04', '2026-01-05'].map(text => plainDate(text));
  const DATE_PATTERNS = [
    'yyyy-MM-dd',
    'MMM d, yyyy',
    'd MMMM yyyy',
    'EEEE, MMMM d, yyyy',
    'EEE, dd LLL y',
    'yyyyMMdd',
    'M/d/yy',
    'yyyy-DDD',
    'y-D',
    'iiii, d.M.yyyy',
    'iii i LLLL yyyy dd',
  ];

  it.each(DATE_PATTERNS)('date pattern %s', pattern => {
    for (const value of dates) expect(parseDate(format(value, pattern), pattern).equals(value)).toBe(true);
  });

  it.each(['ro-RO', 'de-DE', 'fr-FR', 'en-GB'])('names in %s', locale => {
    const pattern = 'EEEE d MMMM yyyy | EEE d MMM yyyy | LLLL';
    for (const value of dates) {
      expect(parseDate(format(value, pattern, { locale }), pattern, { locale }).equals(value)).toBe(true);
    }
  });

  const times = [
    '2026-03-01T00:00:00',
    '2026-03-01T12:00:00',
    '2024-02-29T09:05:07.123',
    '2000-12-31T23:59:59.999',
    '2026-07-04T13:30:45.5',
  ].map(text => plainDateTime(text));
  const DATE_TIME_PATTERNS: readonly (readonly [string, 'minute' | 'second' | 'millisecond'])[] = [
    ['yyyy-MM-dd HH:mm:ss.SSS', 'millisecond'],
    ["yyyy-MM-dd'T'HH:mm:ss", 'second'],
    ['MMM d, yyyy h:mm a', 'minute'],
    ["h:mm:ss aaaa 'on' MM/dd/yyyy", 'second'],
    ['yyyy-MM-dd kk:mm', 'minute'],
    ['yyyy-MM-dd KK:mm aaa', 'minute'],
    ['EEEE, d MMMM yyyy H:m:s', 'second'],
  ];

  it.each(DATE_TIME_PATTERNS)('date-time pattern %s', (pattern, unit) => {
    for (const time of times) {
      const value = time.round({ smallestUnit: unit, roundingMode: 'trunc' });
      expect(parseDateTime(format(value, pattern), pattern).equals(value)).toBe(true);
    }
  });

  const instants = [
    '2026-10-25T03:30:00+03:00[Europe/Bucharest]',
    '2026-10-25T03:30:00+02:00[Europe/Bucharest]',
    '2026-03-29T04:30:00.250+03:00[Europe/Bucharest]',
    '2026-07-01T12:00:00+03:00[Europe/Bucharest]',
  ].map(text => zoned(text));

  it.each(["yyyy-MM-dd'T'HH:mm:ss.SSSXXX", 'yyyy-MM-dd HH:mm:ss.SSS xx', 'yyyy-MM-dd HH:mm:ss.SSS X'])(
    'zoned pattern %s keeps the exact instant across the fold',
    pattern => {
      for (const value of instants)
        expect(parseZoned(format(value, pattern), pattern, BUCHAREST).equals(value)).toBe(true);
    },
  );
});

describe('agrees with date-fns parse when every field is present', () => {
  const reference = new Date(2000, 0, 1);
  const PATTERNS = [
    'yyyy-MM-dd HH:mm:ss',
    'MMM d, yyyy h:mm:ss a',
    'dd/MM/yyyy HH:mm:ss',
    'EEEE, MMMM d, yyyy HH:mm:ss',
    'yyyyMMdd HHmmss',
    "d LLLL yyyy 'at' hh:mm:ss aaa",
    'EEE, dd MMM yy kk:mm:ss',
  ];
  const values = ['2026-03-05T09:07:03', '2024-02-29T00:00:00', '2025-12-31T23:59:59', '2026-07-15T12:30:00'].map(
    text => plainDateTime(text),
  );

  it.each(PATTERNS)('%s', pattern => {
    for (const value of values) {
      const text = format(value, pattern);
      const ours = parseDateTime(text, pattern);
      const theirs = fnsParse(text, pattern, reference);
      expect([ours.year, ours.month, ours.day, ours.hour, ours.minute, ours.second]).toEqual([
        theirs.getFullYear(),
        theirs.getMonth() + 1,
        theirs.getDate(),
        theirs.getHours(),
        theirs.getMinutes(),
        theirs.getSeconds(),
      ]);
    }
  });
});
