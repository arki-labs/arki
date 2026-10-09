import { describe, expect, it } from 'vitest';

import { MockClock } from '@arki/clock';

import { businessCalendar } from './business.js';
import { instant, plainDate, zoned } from './core.js';
import { createDateContext, date, DateValue } from './fluent.js';

const BUC = 'Europe/Bucharest';

describe('date()', () => {
  it('wraps moments and projects instants into the given zone', () => {
    expect(date('2026-01-31T10:00:00Z', { timeZone: BUC }).toString()).toBe(
      '2026-01-31T12:00:00+02:00[Europe/Bucharest]',
    );
    expect(date(new Date('2026-01-31T10:00:00Z'), { timeZone: 'UTC' }).hour).toBe(10);
    expect(date(instant('2026-01-31T10:00:00Z'), { timeZone: BUC }).timeZoneId).toBe(BUC);
    expect(date('2026-01-31T12:00:00+02:00[Europe/Bucharest]').timeZoneId).toBe(BUC);
    expect(date(zoned('2026-01-31T12:00:00+02:00[Europe/Bucharest]'), { timeZone: 'UTC' }).timeZoneId).toBe(BUC);
  });

  it('rejects calendar dates with a hint and refuses numeric coercion', () => {
    expect(() => date('2026-01-31', { timeZone: BUC })).toThrow(/plainDate/);
    const d = date('2026-01-31T10:00:00Z', { timeZone: BUC });
    expect(() => Number(d)).toThrow(TypeError);
    expect(String(d)).toBe('2026-01-31T12:00:00+02:00[Europe/Bucharest]');
    expect(JSON.stringify({ d })).toBe('{"d":"2026-01-31T12:00:00+02:00[Europe/Bucharest]"}');
  });

  it('chains arithmetic, boundaries and rounding without mutating', () => {
    const start = date('2026-01-31T10:07:00Z', { timeZone: BUC });
    const renewal = start.add({ months: 1 }).set({ hour: 9, minute: 0 }).startOf('minute');
    expect(renewal.toPlainDate().toString()).toBe('2026-02-28');
    expect(renewal.toString()).toBe('2026-02-28T09:00:00+02:00[Europe/Bucharest]');
    expect(start.toString()).toBe('2026-01-31T12:07:00+02:00[Europe/Bucharest]');
    expect(start.ceil('minute', { increment: 15 }).minute).toBe(15);
    expect(start.endOf('month').day).toBe(31);
    expect(start.nextBoundary('quarter').toPlainDate().toString()).toBe('2026-04-01');
    expect(start.sub({ days: 31 }).toPlainDate().toString()).toBe('2025-12-31');
    expect(start.startOf('week').dayOfWeek()).toBe(1);
  });

  it('compares and diffs against any DateLike, projecting into its own zone', () => {
    const a = date('2026-03-28T10:00:00Z', { timeZone: BUC });
    expect(a.diff('2026-03-29T10:00:00Z', 'day')).toBe(1);
    expect(a.diff(new Date('2026-03-29T10:00:00Z'), 'hour')).toBe(24);
    expect(a.diff(zoned('2026-03-29T13:00:00+01:00[Europe/London]'), 'hour')).toBe(26);
    expect(a.diffElapsed(a.add({ days: 1 }), 'hour')).toBe(23);
    expect(a.until('2026-05-01T00:00:00Z', { largestUnit: 'month' }).toString()).toBe('P1M2DT15H'); // May 1 00:00Z is 03:00 in Bucharest after DST
    expect(a.isBefore('2026-03-29T10:00:00Z')).toBe(true);
    expect(a.isSameDay(a.inZone('UTC'))).toBe(true);
    expect(a.sameInstant(a.toUTC())).toBe(true);
    expect(a.equals(a.toUTC())).toBe(false);
    expect(a.isBetween('2026-03-28T00:00:00Z', '2026-03-29T00:00:00Z')).toBe(true);
    expect(a.clamp('2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z').toPlainDate().toString()).toBe('2026-04-01');
    expect(a.compare(a)).toBe(0);
  });

  it('exposes calendar, zone, business and display helpers', () => {
    const d = date('2026-10-09T12:37:48Z', { timeZone: BUC, locale: 'en-US' });
    expect(d.isoWeek()).toEqual({ week: 41, weekYear: 2026 });
    expect(d.quarter()).toBe(4);
    expect(d.isWeekend()).toBe(false);
    expect(d.isLeapYear()).toBe(false);
    expect(d.daysInMonth()).toBe(31);
    expect(d.dayOfYear()).toBe(282);
    expect(d.offset()).toBe('+03:00');
    expect(d.reinterpretZone('UTC').toString()).toBe('2026-10-09T15:37:48+00:00[UTC]');
    expect(d.addBusinessDays(1).toPlainDate().toString()).toBe('2026-10-12');
    expect(
      d
        .nextBusinessDay(businessCalendar({ holidays: ['2026-10-12'] }))
        .toPlainDate()
        .toString(),
    ).toBe('2026-10-13');
    expect(d.previousBusinessDay().toPlainDate().toString()).toBe('2026-10-08');
    expect(d.isBusinessDay()).toBe(true);
    expect(d.format('yyyy-MM-dd HH:mm xxx')).toBe('2026-10-09 15:37 +03:00');
    expect(d.formatIntl({ dateStyle: 'medium', timeStyle: 'short' })).toMatch(/^Oct 9, 2026(,| at) 3:37 PM$/); // ICU versions differ on the joiner
    expect(d.relativeTo('2026-10-09T12:42:48Z')).toBe('5 minutes ago');
    expect(d.pipe(z => z.withTimeZone('UTC'))).toBeInstanceOf(DateValue);
    expect(d.pipe(z => z.epochMilliseconds)).toBe(Date.UTC(2026, 9, 9, 12, 37, 48));
    expect(d.parts().hour).toBe(15);
  });
});

describe('createDateContext', () => {
  const clock = new MockClock(new Date('2026-10-09T09:00:00Z'));
  const ctx = createDateContext({ clock, timeZone: BUC, locale: 'ro-RO' });

  it('binds clock, zone and locale', () => {
    expect(ctx.now().toString()).toBe('2026-10-09T12:00:00+03:00[Europe/Bucharest]');
    expect(ctx.today().toString()).toBe('2026-10-09');
    expect(ctx.date('2026-10-09T00:30:00Z').isToday()).toBe(true);
    expect(ctx.isToday(instant('2026-10-08T21:30:00Z'))).toBe(true); // 00:30 Oct 9 in Bucharest
    expect(ctx.isToday(plainDate('2026-10-09'))).toBe(true);
    expect(ctx.now().locale).toBe('ro-RO');
  });

  it('drives time-dependent predicates through the mock clock', () => {
    const deadline = ctx.now().add({ hours: 2 });
    expect(deadline.isFuture()).toBe(true);
    expect(deadline.isPast()).toBe(false);
    expect(deadline.isToday()).toBe(true);
    expect(deadline.fromNow()).toMatch(/2 ore|peste/);
    clock.advance(3 * 60 * 60 * 1000);
    expect(deadline.isPast()).toBe(true);
    expect(ctx.isPast(deadline.value())).toBe(true);
    expect(ctx.now().isTomorrow()).toBe(false);
    expect(ctx.now().add({ days: 1 }).isTomorrow()).toBe(true);
    expect(ctx.now().sub({ days: 1 }).isYesterday()).toBe(true);
    expect(ctx.now().isThisWeek()).toBe(true);
    expect(ctx.now().isThisMonth()).toBe(true);
    expect(ctx.now().isThisYear()).toBe(true);
  });
});
