import { describe, expect, it } from 'vitest';

import type { CalendarUnit, Weekday } from '../types.js';
import { Temporal } from '../types.js';
import { startOfZoned } from './zoned.js';

// `startOf` on zoned values answers from integer math when it can.
// The answer must be the exact ZonedDateTime Temporal would produce, or
// `undefined` (Temporal then runs), never a different value.

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
  'Australia/Lord_Howe',
  'Pacific/Apia',
  'America/Sao_Paulo',
  'Africa/Casablanca',
];

function sampleZoned(next: () => number, index: number): Temporal.ZonedDateTime {
  const zone = ZONES[index % ZONES.length] ?? 'UTC';
  const ms = Math.floor((next() - 0.2) * 5e12);
  const ns = BigInt(ms) * 1_000_000n + (next() < 0.5 ? 0n : BigInt(Math.floor(next() * 1_000_000)));
  const zoned = new Temporal.ZonedDateTime(ns, zone);
  // Push a third of the samples onto the 29th–31st, where month arithmetic clamps.
  return next() < 0.33 ? zoned.with({ day: 28 + Math.floor(next() * 4) }) : zoned;
}

function reference(zoned: Temporal.ZonedDateTime, unit: CalendarUnit, startsOn: Weekday): Temporal.ZonedDateTime {
  const date = zoned.toPlainDate();
  const first =
    unit === 'day'
      ? date
      : unit === 'week'
        ? date.subtract({ days: (date.dayOfWeek - startsOn + 7) % 7 })
        : unit === 'month'
          ? date.with({ day: 1 })
          : unit === 'quarter'
            ? date.with({ month: Math.floor((date.month - 1) / 3) * 3 + 1, day: 1 })
            : date.with({ month: 1, day: 1 });
  return first.toZonedDateTime(zoned.timeZoneId);
}

describe('startOfZoned', () => {
  it('equals Temporal for every calendar unit and week start', () => {
    const next = random(5);
    const units: CalendarUnit[] = ['day', 'week', 'month', 'quarter', 'year'];
    for (let index = 0; index < 4000; index++) {
      const zoned = sampleZoned(next, index);
      const unit = units[index % units.length] ?? 'day';
      const startsOn = (1 + (index % 7)) as Weekday;
      const fast = startOfZoned(zoned, unit, { startsOn, minimalDays: 4 });
      if (fast === undefined) continue;
      expect([zoned.toString(), unit, fast.toString()]).toEqual([
        zoned.toString(),
        unit,
        reference(zoned, unit, startsOn).toString(),
      ]);
    }
  });
});
