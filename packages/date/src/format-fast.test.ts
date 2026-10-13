import { describe, expect, it } from 'vitest';

import { format } from './format.js';
import { Temporal } from './types.js';

// `format` reads its fields from the epoch and a cached zone offset instead of
// Temporal getters. These tests rebuild the expected text from Temporal's own
// getters, so any drift in that arithmetic (pre-1970 moments, nanoseconds,
// days when the offset changes) shows up as a mismatch.

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

const PATTERN = "yyyy-MM-dd'T'HH:mm:ss.SSSSSSSSS xxx RRRR-'W'II-i DDD Q";
const ZONES = ['UTC', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Pacific/Apia', 'Africa/Casablanca'];

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

function expected(zoned: Temporal.ZonedDateTime): string {
  const nanos = zoned.millisecond * 1_000_000 + zoned.microsecond * 1000 + zoned.nanosecond;
  return (
    `${pad(zoned.year, 4)}-${pad(zoned.month, 2)}-${pad(zoned.day, 2)}T${pad(zoned.hour, 2)}:${pad(zoned.minute, 2)}:${pad(zoned.second, 2)}.${pad(nanos, 9)} ` +
    `${zoned.offset.slice(0, 6)} ${pad(zoned.yearOfWeek ?? 0, 4)}-W${pad(zoned.weekOfYear ?? 0, 2)}-${zoned.dayOfWeek} ` +
    `${pad(zoned.dayOfYear, 3)} ${Math.floor((zoned.month - 1) / 3) + 1}`
  );
}

describe('format fields', () => {
  it('match Temporal getters for instants, zoned values and Dates across zones and centuries', () => {
    const next = random(99);
    for (let index = 0; index < 3000; index++) {
      const ms = Math.floor((next() - 0.3) * 6e12); // roughly 1780–2160
      const ns = BigInt(ms) * 1_000_000n + BigInt(Math.floor(next() * 1_000_000));
      const zone = ZONES[index % ZONES.length] ?? 'UTC';
      const zoned = new Temporal.ZonedDateTime(ns, zone);
      const text = expected(zoned);
      expect([zone, format(zoned, PATTERN)]).toEqual([zone, text]);
      expect([zone, format(zoned.toInstant(), PATTERN, { timeZone: zone })]).toEqual([zone, text]);
      const fromDate = expected(new Temporal.ZonedDateTime(BigInt(zoned.epochMilliseconds) * 1_000_000n, zone));
      expect([zone, format(new Date(zoned.epochMilliseconds), PATTERN, { timeZone: zone })]).toEqual([zone, fromDate]);
    }
  });
});
