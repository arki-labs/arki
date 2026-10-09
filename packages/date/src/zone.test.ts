import { describe, expect, it } from 'vitest';

import { instant, plainDate, zoned } from './core.js';
import { atTime, inZone, isValidTimeZone, offset, offsetMinutes, reinterpretZone, toUTC } from './zone.js';

describe('zone projection', () => {
  const i = instant('2026-10-09T10:00:00Z');

  it('inZone keeps the instant and changes the wall clock', () => {
    const buc = inZone(i, 'Europe/Bucharest');
    expect(buc.toString()).toBe('2026-10-09T13:00:00+03:00[Europe/Bucharest]');
    expect(inZone(buc, 'America/New_York').hour).toBe(6);
    expect(inZone(new Date('2026-10-09T10:00:00Z'), 'Asia/Kathmandu').toString()).toBe(
      '2026-10-09T15:45:00+05:45[Asia/Kathmandu]',
    );
    expect(toUTC(buc).toString()).toBe('2026-10-09T10:00:00+00:00[UTC]');
  });

  it('reinterpretZone keeps the wall clock and changes the instant', () => {
    const buc = zoned('2026-10-09T13:00:00+03:00[Europe/Bucharest]');
    const ny = reinterpretZone(buc, 'America/New_York');
    expect(ny.toString()).toBe('2026-10-09T13:00:00-04:00[America/New_York]');
    expect(ny.epochMilliseconds - buc.epochMilliseconds).toBe(7 * 3_600_000);
    const fold = zoned('2026-10-25T03:30:00+03:00[Europe/Bucharest]'); // 03:30 happens twice that night
    expect(reinterpretZone(fold, 'Europe/Bucharest').equals(fold)).toBe(true);
    expect(() => reinterpretZone(fold, 'Europe/Bucharest', { disambiguation: 'reject' })).toThrow(RangeError);
  });

  it('atTime combines a date, a wall time and a zone', () => {
    expect(atTime(plainDate('2026-10-09'), { hour: 9, minute: 30 }, 'Europe/Bucharest').toString()).toBe(
      '2026-10-09T09:30:00+03:00[Europe/Bucharest]',
    );
    expect(() =>
      atTime(plainDate('2026-03-29'), { hour: 3, minute: 30 }, 'Europe/Bucharest', { disambiguation: 'reject' }),
    ).toThrow(RangeError);
  });

  it('exposes offsets and validates zone ids', () => {
    const lh = inZone(i, 'Australia/Lord_Howe');
    expect(offset(lh)).toBe('+11:00');
    expect(offsetMinutes(inZone(instant('2026-06-01T00:00Z'), 'Australia/Lord_Howe'))).toBe(630);
    expect(offsetMinutes(inZone(i, 'America/New_York'))).toBe(-240);
    expect(isValidTimeZone('Europe/Bucharest')).toBe(true);
    expect(isValidTimeZone('+05:30')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
