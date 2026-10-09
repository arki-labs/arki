import { format as fnsFormat } from 'date-fns/format';
import { describe, expect, it } from 'vitest';

import { instant, plainDate, plainDateTime, zoned } from './core.js';
import { format, formatIntl, formatISO, formatRange, toHumanReadableDate } from './format.js';
import { dateTimeFormat, INTL_CACHE_LIMIT, intlCacheSize } from './internal/intl.js';
import { Temporal } from './types.js';

// Every pattern the legacy importers (and the presets they rely on) use. Output must equal date-fns byte for byte.
const PATTERNS = [
  'yyyy-MM-dd',
  'MMM d',
  'MMM d, yyyy',
  'MMMM d',
  'd',
  'PP',
  'MMM yyyy',
  'EEE',
  'yyyyMMdd',
  'h:mm a',
  'd MMMM yyyy',
  'PPP',
  'MMMM yyyy',
  'MMM d, yyyy h:mm a',
  'LLL dd, y',
  'EEEE, MMMM d, yyyy',
  'PPPP',
  'P',
  'p',
  'pp',
  'ppp',
  'pppp',
  'Pp',
  'PPpp',
  'HH:mm:ss.SSS',
  'XXX',
  'xxx',
  'X',
  'O',
  'OOOO',
  'QQQ',
  'II',
  'RRRR',
  'D',
  'DDD',
  'i',
  'iiii',
  'K:mm aaa',
  'kk',
  'do MMM',
  'G',
  'GGGG',
  'yy',
  'yyyyy',
  "'year' yyyy 'q' Q",
  "h 'o''clock' a",
  'S',
  'SS',
];

/** Deterministic LCG (Numerical Recipes constants) so a failure reproduces exactly. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function sampleDates(): Date[] {
  const next = lcg(0x20_26_10_09);
  const from = Date.UTC(1995, 0, 1);
  const span = Date.UTC(2040, 11, 31, 23, 59, 59, 999) - from;
  const dates = Array.from({ length: 400 }, () => new Date(from + Math.floor(next() * span)));
  // DST edges in the runtime zone (EU spring-forward / fall-back days, US fall-back night) plus noon and midnight.
  for (const hour of [0, 1, 2, 3, 4, 12, 23]) {
    dates.push(new Date(2026, 2, 29, hour, 30, 15, 7), new Date(2026, 9, 25, hour, 30, 15, 70));
  }
  dates.push(new Date(2026, 10, 1, 2, 30), new Date(2026, 9, 9, 0, 0, 0, 0), new Date(2026, 9, 9, 12, 0, 0, 0));
  return dates;
}

/** Reference output straight from Intl, to compare formatIntl against. */
function intl(options: Intl.DateTimeFormatOptions, epochMs: number): string {
  return new Intl.DateTimeFormat('en-US', options).format(epochMs);
}

/** A distinct fixed-offset zone per index (`+00:00`, `+00:01`, …) to fill the formatter cache. */
function offsetZone(index: number): string {
  return `+${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`;
}

describe('format — differential against date-fns v4', () => {
  const dates = sampleDates();

  it.each(PATTERNS)('%s matches date-fns for every sample', pattern => {
    const mismatches = dates.flatMap(date => {
      const ours = format(date, pattern);
      const theirs = fnsFormat(date, pattern, { useAdditionalDayOfYearTokens: true });
      return ours === theirs ? [] : [`${date.toISOString()}: ${JSON.stringify(ours)} !== ${JSON.stringify(theirs)}`];
    });
    expect(mismatches).toEqual([]);
  });
});

describe('format — Temporal inputs', () => {
  const evening = zoned('2026-10-09T15:37:48+03:00[Europe/Bucharest]');

  it('formats a PlainDate with date tokens', () => {
    expect(format(plainDate('2026-05-20'), 'LLL dd, y')).toBe('May 20, 2026');
    expect(format(plainDate('2026-10-09'), 'PPPP')).toBe('Friday, October 9th, 2026');
    expect(format(plainDate('2026-10-09'), 'EEEEEE EEEEE iiiiii')).toBe('Fr F Fr');
  });

  it('keeps a ZonedDateTime in its own zone', () => {
    expect(format(evening, 'yyyy-MM-dd HH:mm XXX')).toBe('2026-10-09 15:37 +03:00');
    expect(format(evening, 'pppp')).toBe('3:37:48 PM GMT+03:00');
    expect(format(evening, 'ppp')).toBe('3:37:48 PM GMT+3');
    expect(format(zoned('2026-10-09T12:00:00Z[UTC]'), 'X xx O')).toBe('Z +0000 GMT+0');
  });

  it('projects an Instant into the requested zone', () => {
    const moment = instant('2026-10-09T12:37:48Z');
    expect(format(moment, 'yyyy-MM-dd HH:mm XXX', { timeZone: 'Asia/Tokyo' })).toBe('2026-10-09 21:37 +09:00');
    expect(format(moment, 'yyyy-MM-dd HH:mm xxxxx', { timeZone: 'America/St_Johns' })).toBe('2026-10-09 10:07 -02:30');
  });

  it('renders z / zzzz as the Intl zone name, not a GMT offset', () => {
    const name = (width: 'short' | 'long'): string | undefined =>
      new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Bucharest', timeZoneName: width })
        .formatToParts(evening.epochMilliseconds)
        .find(part => part.type === 'timeZoneName')?.value;
    expect(format(evening, 'z')).toBe(name('short'));
    expect(format(evening, 'zzzz')).toBe(name('long'));
    expect(format(evening, 'zzzz')).toBe('Eastern European Summer Time');
  });

  it('shows sub-millisecond fractions a Date cannot carry', () => {
    expect(format(plainDateTime('2026-10-09T15:37:48.123456789'), 'ss.SSSSSS')).toBe('48.123456');
    expect(format(plainDateTime('2026-10-09T15:37:48.5'), 'S SSSS')).toBe('5 5000');
  });

  it('uses era years before year 1 (ISO year 0 = 1 BC)', () => {
    expect(format(plainDate('0000-06-01'), 'y G GGGG')).toBe('1 BC Before Christ');
    expect(format(plainDate('-000001-06-01'), 'yyyy GGGGG')).toBe('0002 B');
  });

  it('uses noon / midnight for b and en-US day-period widths for a', () => {
    expect(format(plainDateTime('2026-10-09T12:00'), 'b bbb bbbb bbbbb')).toBe('noon noon noon n');
    expect(format(plainDateTime('2026-10-09T00:15'), 'b bbbbb')).toBe('midnight mi');
    expect(format(plainDateTime('2026-10-09T15:00'), 'a aa aaa aaaa aaaaa b')).toBe('PM PM pm p.m. p PM');
  });

  it('renders ordinals and quarters as date-fns en-US', () => {
    expect(format(plainDate('2026-10-22'), 'do Mo Qo QQQQ QQQQQ Do Io')).toBe('22nd 10th 4th 4th quarter 4 295th 43rd');
    expect(format(plainDate('2026-01-13'), 'do')).toBe('13th');
    expect(format(plainDate('2026-01-01'), 'do')).toBe('1st');
  });

  it('takes month and weekday words from Intl in the requested locale', () => {
    expect(format(plainDate('2026-05-20'), 'EEEE d LLLL', { locale: 'ro-RO' })).toBe('miercuri 20 mai');
  });

  it('fails loud on tokens the value does not carry', () => {
    expect(() => format(plainDate('2026-05-20'), 'HH')).toThrow(RangeError);
    expect(() => format(plainDate('2026-05-20'), 'p')).toThrow(RangeError);
    expect(() => format(plainDateTime('2026-05-20T10:00'), 'XXX')).toThrow(RangeError);
    expect(() => format(plainDateTime('2026-05-20T10:00'), 'pppp')).toThrow(RangeError);
    expect(format(plainDateTime('2026-05-20T10:00'), 'PPpp')).toBe('May 20, 2026, 10:00:00 AM');
  });

  it('fails loud on unknown letters, an invalid Date, and a zone conflict', () => {
    for (const pattern of ['Y', 'w', 'q', 'e', 'c', 'B', 'u', 'T', 'o', 'yyyy-MM-dd T']) {
      expect(() => format(plainDate('2026-05-20'), pattern), pattern).toThrow(RangeError);
    }
    expect(format(plainDate('2026-05-20'), "'Today is' EEEE")).toBe('Today is Wednesday');
    expect(() => format(new Date(Number.NaN), 'yyyy')).toThrow(RangeError);
    expect(() => format(evening, 'HH', { timeZone: 'UTC' })).toThrow(RangeError);
    expect(format(evening, 'HH', { timeZone: 'Europe/Bucharest' })).toBe('15');
    expect(() => format(plainDate('2026-05-20'), 'd', { timeZone: 'UTC' })).toThrow(RangeError);
  });
});

describe('toHumanReadableDate / formatISO', () => {
  it('keeps the legacy "LLL dd, y" output for Date and PlainDate', () => {
    expect(toHumanReadableDate(new Date(2026, 4, 20, 23, 59))).toBe('May 20, 2026');
    expect(toHumanReadableDate(plainDate('2026-05-02'))).toBe('May 02, 2026');
  });

  it('is toString() for every value kind', () => {
    expect(formatISO(plainDate('2026-05-20'))).toBe('2026-05-20');
    expect(formatISO(zoned('2026-10-09T15:37:48+03:00[Europe/Bucharest]'))).toBe(
      '2026-10-09T15:37:48+03:00[Europe/Bucharest]',
    );
    expect(formatISO(Temporal.Duration.from({ hours: 1, minutes: 30 }))).toBe('PT1H30M');
  });
});

describe('formatIntl', () => {
  const evening = zoned('2026-10-09T15:37:48+03:00[Europe/Bucharest]');

  it('formats a PlainDate by its fields, never shifted by a zone', () => {
    expect(formatIntl(plainDate('2026-05-20'), { dateStyle: 'medium' })).toBe('May 20, 2026');
    expect(formatIntl(plainDate('2026-05-20'), { dateStyle: 'full' })).toBe('Wednesday, May 20, 2026');
    expect(formatIntl(plainDate('2026-05-20'), { month: 'long', year: 'numeric' })).toBe('May 2026');
  });

  it('rejects time options on a PlainDate', () => {
    for (const options of [
      { hour: 'numeric' },
      { minute: '2-digit' },
      { second: 'numeric' },
      { timeStyle: 'short' },
      { timeZoneName: 'short' },
    ] as const) {
      expect(() => formatIntl(plainDate('2026-05-20'), options)).toThrow(RangeError);
    }
  });

  it('uses a ZonedDateTime’s own zone and rejects a different one', () => {
    const expected = intl(
      { dateStyle: 'medium', timeStyle: 'long', timeZone: 'Europe/Bucharest' },
      evening.epochMilliseconds,
    );
    expect(formatIntl(evening, { dateStyle: 'medium', timeStyle: 'long' })).toBe(expected);
    expect(formatIntl(evening, { dateStyle: 'medium', timeStyle: 'long', timeZone: 'Europe/Bucharest' })).toBe(
      expected,
    );
    expect(() => formatIntl(evening, { timeZone: 'UTC' })).toThrow(RangeError);
  });

  it('projects Date / Instant into options.timeZone', () => {
    const moment = instant('2026-10-09T12:37:48Z');
    const expected = intl({ timeStyle: 'short', timeZone: 'Asia/Tokyo' }, moment.epochMilliseconds);
    expect(formatIntl(moment, { timeStyle: 'short', timeZone: 'Asia/Tokyo' })).toBe(expected);
    expect(formatIntl(new Date(moment.epochMilliseconds), { timeStyle: 'short', timeZone: 'Asia/Tokyo' })).toBe(
      expected,
    );
  });

  it('formats a PlainDateTime as its wall clock with no zone name', () => {
    const wall = plainDateTime('2026-10-09T15:37');
    expect(formatIntl(wall, { timeStyle: 'short' })).toBe(
      intl({ timeStyle: 'short', timeZone: 'UTC' }, Date.UTC(2026, 9, 9, 15, 37)),
    );
    expect(() => formatIntl(wall, { timeZoneName: 'short' })).toThrow(RangeError);
    expect(() => formatIntl(wall, { timeZone: 'UTC' })).toThrow(RangeError);
  });

  it('renders other locales', () => {
    const text = formatIntl(plainDate('2026-05-20'), { locale: 'ro-RO', dateStyle: 'long' });
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('mai');
  });
});

describe('Intl formatter cache', () => {
  it('reuses formatters and never holds more than the limit', () => {
    for (let index = 0; index < INTL_CACHE_LIMIT + 50; index += 1) {
      dateTimeFormat('en-US', { timeZone: offsetZone(index), hour: 'numeric' });
    }
    expect(intlCacheSize()).toBeLessThanOrEqual(INTL_CACHE_LIMIT);
    const options = { timeZone: offsetZone(INTL_CACHE_LIMIT + 49), hour: 'numeric' } as const;
    expect(dateTimeFormat('en-US', options)).toBe(dateTimeFormat('en-US', options));
  });
});

describe('formatRange', () => {
  it('prints a locale span for dates, wall clocks and zoned moments', () => {
    expect(formatRange(plainDate('2026-05-20'), plainDate('2026-05-24'), { dateStyle: 'medium' })).toMatch(
      /^May 20\s*–\s*24, 2026$/,
    );
    expect(
      formatRange(zoned('2026-05-20T09:00[Europe/Bucharest]'), zoned('2026-05-20T17:30[Europe/Bucharest]'), {
        timeStyle: 'short',
      }),
    ).toMatch(/^9:00\sAM\s*–\s*5:30\sPM$/);
    expect(
      formatRange(plainDateTime('2026-05-20T09:00'), plainDateTime('2026-05-21T09:00'), {
        dateStyle: 'short',
        timeStyle: 'short',
      }),
    ).toMatch(/5\/20\/26.+5\/21\/26/);
  });

  it('rejects mixed kinds, mixed zones and time options on dates', () => {
    expect(() => formatRange(plainDate('2026-05-20'), plainDateTime('2026-05-21T09:00'))).toThrow(/same kind/);
    expect(() =>
      formatRange(zoned('2026-05-20T09:00[Europe/Bucharest]'), zoned('2026-05-20T09:00[Asia/Tokyo]')),
    ).toThrow(/share a zone/);
    expect(() => formatRange(plainDate('2026-05-20'), plainDate('2026-05-21'), { hour: 'numeric' })).toThrow(/hour/);
  });
});

describe('format pattern reuse', () => {
  it('gives the same text on repeated calls with the same pattern', () => {
    const value = zoned('2026-05-20T09:05:07.123[Europe/Bucharest]');
    const first = format(value, "yyyy-MM-dd 'at' HH:mm:ss.SSS xxx 'it''s'");
    for (let i = 0; i < 3; i++) expect(format(value, "yyyy-MM-dd 'at' HH:mm:ss.SSS xxx 'it''s'")).toBe(first);
    expect(first).toBe("2026-05-20 at 09:05:07.123 +03:00 it's");
  });
});
