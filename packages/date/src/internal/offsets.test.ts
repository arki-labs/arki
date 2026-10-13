import { describe, expect, it } from 'vitest';

import type { Disambiguation } from '../types.js';
import { Temporal } from '../types.js';
import { civilFromDays, dayOfYearOf, daysFromCivil, isoWeekOf, MS_PER_DAY, weekdayOfDays } from './civil.js';
import { epochFromWall, offsetAt, startOfDayEpoch } from './offsets.js';

// The fast paths answer from these helpers instead of Temporal. Every answer
// must equal Temporal's, so each test compares the two on many values,
// including the moments where zones change their offset.

/** Deterministic xorshift, so a failure names a reproducible input. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

const ZONES = [
  'UTC',
  'America/New_York',
  'Europe/Bucharest',
  'Europe/London',
  'Australia/Lord_Howe', // 30-minute daylight saving
  'Asia/Kathmandu', // +05:45
  'Pacific/Apia', // skipped 2011-12-30 entirely
  'America/Sao_Paulo', // daylight saving that started at midnight
  'Africa/Casablanca', // transitions around Ramadan, sometimes weeks apart
  'America/St_Johns', // -03:30
  'Antarctica/Troll', // +02:00 / +00:00
  '+05:30',
  '-08:00',
];

const FROM = Date.UTC(1900, 0, 1);
const TO = Date.UTC(2100, 0, 1);

/** Random moments plus the moments right at, just before and just after each transition. */
function momentsFor(zone: string, next: () => number): number[] {
  const moments: number[] = [];
  for (let index = 0; index < 300; index++) moments.push(Math.floor(FROM + next() * (TO - FROM)));
  let cursor = new Temporal.ZonedDateTime(BigInt(Date.UTC(1990, 0, 1)) * 1_000_000n, zone);
  for (let index = 0; index < 40; index++) {
    const transition = cursor.getTimeZoneTransition('next');
    if (transition === null) break;
    cursor = transition;
    const at = cursor.epochMilliseconds;
    moments.push(at - 1, at, at + 1, at - MS_PER_DAY, at + MS_PER_DAY);
  }
  return moments;
}

describe('civil arithmetic', () => {
  it('matches Temporal for day counts, weekdays, days of the year and ISO weeks', () => {
    const next = random(7);
    for (let index = 0; index < 5000; index++) {
      const days = Math.floor((next() - 0.5) * 2 * 100_000_000);
      const date = Temporal.PlainDate.from('1970-01-01').add({ days });
      const civil = civilFromDays(days);
      expect(civil).toEqual({ year: date.year, month: date.month, day: date.day });
      expect(daysFromCivil(date.year, date.month, date.day)).toBe(days);
      expect(weekdayOfDays(days)).toBe(date.dayOfWeek);
      expect(dayOfYearOf(date.year, date.month, date.day)).toBe(date.dayOfYear);
      expect(isoWeekOf(date.year, date.month, date.day)).toEqual({ week: date.weekOfYear, weekYear: date.yearOfWeek });
    }
  });
});

describe('zone offsets', () => {
  it.each(ZONES)('offsetAt equals Temporal in %s', zone => {
    for (const ms of momentsFor(zone, random(zone.length * 31))) {
      const expected = new Temporal.ZonedDateTime(BigInt(ms) * 1_000_000n, zone).offsetNanoseconds / 1_000_000;
      expect([ms, offsetAt(zone, ms)]).toEqual([ms, expected]);
    }
  });

  const RULES: Disambiguation[] = ['compatible', 'earlier', 'later', 'reject'];

  it.each(ZONES)('epochFromWall equals PlainDateTime#toZonedDateTime in %s, for every disambiguation', zone => {
    let fast = 0;
    for (const ms of momentsFor(zone, random(zone.length * 17))) {
      // A wall-clock reading near each moment, including readings inside gaps and folds.
      const wall = ms + offsetAt(zone, ms) + ((ms % 7) - 3) * 900_000;
      const plain = Temporal.Instant.fromEpochMilliseconds(wall).toZonedDateTimeISO('UTC').toPlainDateTime();
      for (const disambiguation of RULES) {
        let expected: number | 'throws';
        try {
          expected = plain.toZonedDateTime(zone, { disambiguation }).epochMilliseconds;
        } catch {
          expected = 'throws';
        }
        const actual = epochFromWall(zone, wall, disambiguation);
        if (actual === undefined) {
          // Only `reject` on an ambiguous reading, or several nearby transitions, may fall back.
          continue;
        }
        fast++;
        expect([plain.toString(), disambiguation, actual]).toEqual([plain.toString(), disambiguation, expected]);
      }
    }
    expect(fast).toBeGreaterThan(0);
  });

  it.each(ZONES)('startOfDayEpoch equals PlainDate#toZonedDateTime in %s', zone => {
    for (const ms of momentsFor(zone, random(zone.length * 13))) {
      const wall = ms + offsetAt(zone, ms);
      const days = Math.floor(wall / MS_PER_DAY);
      const civil = civilFromDays(days);
      const expected = Temporal.PlainDate.from(civil).toZonedDateTime(zone).epochMilliseconds;
      const actual = startOfDayEpoch(zone, days * MS_PER_DAY);
      if (actual !== undefined) expect([civil, actual]).toEqual([civil, expected]);
    }
  });

  it('throws RangeError for an unknown zone, as Temporal does', () => {
    expect(() => offsetAt('Mars/Olympus_Mons', 0)).toThrow(RangeError);
  });
});
