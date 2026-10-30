import { describe, expect, it } from 'vitest';

import { plainDate, zoned } from './core.js';
import { InvalidDateText } from './failures.js';
import { Temporal } from './types.js';
import {
  absDuration,
  addDuration,
  compareDurations,
  days,
  duration,
  formatDurationIntl,
  formatDurationISO,
  hours,
  humanizeDuration,
  isNegativeDuration,
  isZeroDuration,
  milliseconds,
  minutes,
  months,
  parseDuration,
  multiplyDuration,
  negateDuration,
  normalizeDuration,
  seconds,
  subDuration,
  totalDuration,
  toUnits,
  weeks,
  years,
} from './duration.js';
import { hasDurationFormat } from './internal/intl.js';

const d = (text: string) => duration(text);

describe('duration construction', () => {
  it('parses ISO text, expands quarters and passes Durations through', () => {
    expect(duration('P1DT2H').toString()).toBe('P1DT2H');
    expect(duration({ quarters: 1, days: 2 }).toString()).toBe('P3M2D');
    const same = d('PT5M');
    expect(duration(same)).toBe(same);
    expect(() => duration('one day')).toThrow(RangeError);
  });

  it('builds single-unit durations and rejects fractions', () => {
    expect(
      [years(2), months(3), weeks(1), days(4), hours(5), minutes(6), seconds(7), milliseconds(500)].map(String),
    ).toEqual(['P2Y', 'P3M', 'P1W', 'P4D', 'PT5H', 'PT6M', 'PT7S', 'PT0.5S']);
    expect(() => days(1.5)).toThrow(RangeError);
  });
});

describe('addDuration / subDuration', () => {
  // Each group balances inside itself and never carries into the next.
  const cases: readonly (readonly [string, '+' | '-', string, string])[] = [
    ['PT2H', '-', 'PT30M', 'PT1H30M'],
    ['P1Y', '-', 'P2M', 'P10M'],
    ['P1W', '+', 'P3D', 'P10D'],
    ['P2W', '-', 'P1W', 'P1W'],
    ['P11M', '+', 'P2M', 'P1Y1M'],
    ['PT59M', '+', 'PT2M', 'PT1H1M'],
    ['P1D', '+', 'PT25H', 'P1DT25H'],
    ['P1M', '+', 'P40D', 'P1M40D'],
    ['P1D', '-', 'P1D', 'PT0S'],
    ['-PT1H', '-', 'PT30M', '-PT1H30M'],
  ];

  it.each(cases)('%s %s %s = %s', (a, op, b, expected) => {
    const result = op === '+' ? addDuration(d(a), d(b)) : subDuration(d(a), d(b));
    expect(result.toString()).toBe(expected);
  });

  it('rejects results whose groups disagree in sign instead of guessing a day length', () => {
    expect(() => subDuration(d('P1D'), d('PT1H'))).toThrow(/relativeTo/);
    expect(() => subDuration(d('P1M'), d('P1D'))).toThrow(RangeError);
    expect(() => addDuration(d('P1Y'), d('-PT1S'))).toThrow(RangeError);
  });
});

describe('multiply / negate / abs', () => {
  it('scales every field without re-balancing', () => {
    expect(multiplyDuration(d('P1DT2H'), 3).toString()).toBe('P3DT6H');
    expect(multiplyDuration(d('PT30M'), -2).toString()).toBe('-PT60M');
    expect(multiplyDuration(d('P1Y'), 0).toString()).toBe('PT0S');
  });

  it('accepts only safe integer factors', () => {
    expect(() => multiplyDuration(d('PT1H'), 1.5)).toThrow(RangeError);
    expect(() => multiplyDuration(d('PT1H'), Number.NaN)).toThrow(RangeError);
  });

  it('negates and takes the absolute value', () => {
    expect(negateDuration(d('P1D')).toString()).toBe('-P1D');
    expect(absDuration(d('-PT5M')).toString()).toBe('PT5M');
  });
});

describe('normalizeDuration', () => {
  it('counts month lengths from relativeTo, clamping across month ends', () => {
    // Jan 31 + 1 month clamps to Feb 28, + 15 days = Mar 15: 43 days.
    expect(normalizeDuration(d('P1M15D'), { largestUnit: 'day', relativeTo: plainDate('2026-01-31') }).toString()).toBe(
      'P43D',
    );
    // Mar 31 + 1 month = Apr 30, + 15 days = May 15: 45 days.
    expect(normalizeDuration(d('P1M15D'), { largestUnit: 'day', relativeTo: plainDate('2026-03-31') }).toString()).toBe(
      'P45D',
    );
  });

  it('treats a day as 24 hours without relativeTo and honours rounding', () => {
    expect(normalizeDuration(d('PT36H'), { largestUnit: 'day' }).toString()).toBe('P1DT12H');
    expect(
      normalizeDuration(d('PT1H29M'), { largestUnit: 'hour', smallestUnit: 'hour', roundingMode: 'trunc' }).toString(),
    ).toBe('PT1H');
  });

  it('uses the real day length of a zoned anchor', () => {
    const springForward = zoned({ year: 2026, month: 3, day: 29 }, 'Europe/Bucharest');
    expect(normalizeDuration(d('PT24H'), { largestUnit: 'day', relativeTo: springForward }).toString()).toBe('P1DT1H');
  });
});

describe('totalDuration', () => {
  it('totals in one unit, with quarters as months ÷ 3', () => {
    expect(totalDuration(d('PT90M'), 'hour')).toBe(1.5);
    expect(totalDuration(d('P6M'), 'quarter', { relativeTo: plainDate('2026-01-01') })).toBe(2);
    expect(totalDuration(d('P1M'), 'day', { relativeTo: plainDate('2026-02-01') })).toBe(28);
  });

  it('needs relativeTo to turn months into days', () => {
    expect(() => totalDuration(d('P1M'), 'day')).toThrow(RangeError);
  });
});

describe('toUnits', () => {
  it('returns whole leading units and a fractional last unit, in the requested order', () => {
    const split = toUnits(d('PT90M'), ['hour', 'minute']);
    expect(split).toEqual({ hour: 1, minute: 30 });
    expect(Object.keys(split)).toEqual(['hour', 'minute']);
    expect(toUnits(d('PT90M'), ['hour'])).toEqual({ hour: 1.5 });
    expect(toUnits(d('P1DT6H'), ['day', 'hour'])).toEqual({ day: 1, hour: 6 });
    expect(toUnits(d('P1DT6H'), ['day'])).toEqual({ day: 1.25 });
    expect(toUnits(d('P10D'), ['week', 'day'])).toEqual({ week: 1, day: 3 });
    expect(toUnits(d('P1Y6M'), ['year'])).toEqual({ year: 1.5 });
    expect(toUnits(d('P1Y2M'), ['year', 'month', 'day'])).toEqual({ year: 1, month: 2, day: 0 });
    expect(Object.isFrozen(split)).toBe(true);
  });

  it('rejects units that are repeated or out of order', () => {
    expect(() => toUnits(d('PT1H'), ['minute', 'hour'])).toThrow(RangeError);
    expect(() => toUnits(d('PT1H'), ['hour', 'hour'])).toThrow(RangeError);
    expect(() => toUnits(d('PT1H'), [])).toThrow(RangeError);
  });

  it('converts months to days only with an anchor', () => {
    expect(() => toUnits(d('P1M'), ['day'])).toThrow(RangeError);
    expect(toUnits(d('P1M'), ['day'], { relativeTo: plainDate('2026-02-01') })).toEqual({ day: 28 });
    // Jan 31 + P1M10D = Mar 10; Jan 31 → Feb 28 is one (clamped) month, then 10 days.
    expect(toUnits(d('P1M10D'), ['month', 'day'], { relativeTo: plainDate('2026-01-31') })).toEqual({
      month: 1,
      day: 10,
    });
  });
});

describe('compare and predicates', () => {
  it('compares by length, using relativeTo for calendar units', () => {
    expect(compareDurations(d('PT1H'), d('PT60M'))).toBe(0);
    expect(compareDurations(d('PT1H'), d('PT61M'))).toBe(-1);
    expect(compareDurations(d('P1M'), d('P30D'), { relativeTo: plainDate('2026-02-01') })).toBe(-1);
    expect(compareDurations(d('P1M'), d('P30D'), { relativeTo: plainDate('2026-01-01') })).toBe(1);
    expect(() => compareDurations(d('P1M'), d('P30D'))).toThrow(RangeError);
  });

  it('detects zero and negative durations and prints ISO text', () => {
    expect(isZeroDuration(d('PT0S'))).toBe(true);
    expect(isZeroDuration(d('PT1S'))).toBe(false);
    expect(isNegativeDuration(d('-P1D'))).toBe(true);
    expect(isNegativeDuration(d('P1D'))).toBe(false);
    expect(formatDurationISO(d('P1Y2M3DT4H'))).toBe('P1Y2M3DT4H');
  });
});

describe('humanizeDuration', () => {
  // en-US Intl.ListFormat `conjunction` joins two items with "and", three with a serial comma.
  const cases: readonly (readonly [string, Parameters<typeof humanizeDuration>[1], string])[] = [
    ['P1DT2H', undefined, '1 day and 2 hours'],
    ['P1Y2M3D', undefined, '1 year, 2 months, and 3 days'],
    ['P1Y2M3D', { maximumUnits: 2 }, '1 year and 2 months'],
    ['P10D', undefined, '1 week and 3 days'],
    ['P1M', undefined, '1 month'],
    ['PT0S', undefined, '0 seconds'],
    ['-PT90M', undefined, '-1 hour and 30 minutes'],
    ['PT90M', { units: ['hour'] }, '1.5 hours'],
    ['PT2H', { style: 'short' }, '2 hr'],
    ['PT2H5M', { style: 'narrow' }, '2h and 5m'],
    ['P1M', { units: ['day'], relativeTo: plainDate('2026-02-01') }, '28 days'],
  ];

  it.each(cases)('%s %o → %s', (text, options, expected) => {
    expect(humanizeDuration(d(text), options)).toBe(expected);
  });

  it('formats in the caller locale', () => {
    const ro = humanizeDuration(d('P1DT2H'), { locale: 'ro-RO' });
    expect(ro).not.toBe('');
    expect(ro).not.toBe(humanizeDuration(d('P1DT2H')));
  });

  it('refuses to turn months into days without an anchor', () => {
    expect(() => humanizeDuration(d('P1M'), { units: ['day'] })).toThrow(RangeError);
    expect(() => humanizeDuration(d('PT1H'), { maximumUnits: 0 })).toThrow(RangeError);
  });
});

describe('formatDurationIntl', () => {
  it.skipIf(!hasDurationFormat())('prints locale text through Intl.DurationFormat', () => {
    expect(formatDurationIntl(d('PT1H30M'), { style: 'short' })).toMatch(/1 hr.*30 min/);
    expect(formatDurationIntl(d('P1DT2H'), { locale: 'ro-RO' })).toMatch(/1 zi.*2 ore/);
  });
});

describe('parseDuration', () => {
  it('reads ISO duration text', () => {
    const result = parseDuration('P1DT2H');
    expect(InvalidDateText.is(result)).toBe(false);
    expect(result instanceof Temporal.Duration && result.toString()).toBe('P1DT2H');
  });

  it('returns InvalidDateText for text from outside instead of throwing, with a bounded copy of the text', () => {
    const result = parseDuration('two days');
    expect(InvalidDateText.is(result) && result.data).toEqual({
      operation: 'parseDuration',
      reason: 'invalid_duration',
      input: 'two days',
      truncated: false,
    });
    const long = parseDuration(`P${'9'.repeat(5000)}`);
    expect(InvalidDateText.is(long) && long.data.truncated).toBe(true);
  });
});

describe('locale text from outside', () => {
  it('falls back to en-US for a malformed locale tag instead of throwing', () => {
    expect(humanizeDuration(d('P1DT2H'), { locale: 'not a locale!' })).toBe(humanizeDuration(d('P1DT2H')));
    if (hasDurationFormat()) {
      expect(formatDurationIntl(d('PT1H30M'), { locale: 'xx_yy' })).toBe(formatDurationIntl(d('PT1H30M')));
    }
  });
});
