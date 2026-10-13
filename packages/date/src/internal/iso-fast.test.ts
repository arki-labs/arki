import { describe, expect, it } from 'vitest';

import { readCommonISO, readLenientISO } from './iso.js';

// parseISO answers from `readCommonISO` first and from the lenient reader
// otherwise. Callers must not be able to tell which one ran, so whenever the
// fast reader answers, its answer must equal the lenient reader's.

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

const ZONES = ['UTC', 'America/New_York', 'Europe/Bucharest', 'Australia/Lord_Howe', 'Pacific/Apia', 'Asia/Kathmandu'];

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

function two(next: () => number, max: number): string {
  return String(Math.floor(next() * (max + 1))).padStart(2, '0');
}

/** Mostly well-formed text, with deliberate edge values and malformed variants mixed in. */
function sample(next: () => number): string {
  const year = String(Math.floor(next() * 10_000)).padStart(4, '0');
  let text = `${year}-${two(next, 13)}-${two(next, 32)}`;
  if (next() < 0.85) {
    text += pick(next, ['T', ' ', 't']) + `${two(next, 25)}:${two(next, 61)}`;
    if (next() < 0.7) text += `:${two(next, 61)}`;
    if (next() < 0.4)
      text += pick(next, ['.', ',']) + String(Math.floor(next() * 1e9)).slice(0, 1 + Math.floor(next() * 9));
    text += pick(next, ['', 'Z', 'z', '+02:00', '-05:30', '+0530', '+03', '-11:75', '+1', ' Z', '+02:00:00']);
  }
  return text;
}

describe('readCommonISO', () => {
  it('equals readLenientISO on every text it accepts', () => {
    const next = random(2026);
    let fast = 0;
    for (let index = 0; index < 20_000; index++) {
      const text = sample(next);
      const zone = pick(next, ZONES);
      const actual = readCommonISO(text, () => zone);
      if (actual === undefined) continue;
      fast++;
      expect([text, zone, actual]).toEqual([text, zone, readLenientISO(text, zone)?.epochMilliseconds]);
    }
    // The fast path must actually carry the common shapes.
    expect(fast).toBeGreaterThan(5000);
  });

  it.each([
    ['2026-03-29T03:30:00', 'Europe/Bucharest'], // skipped hour
    ['2026-10-25T03:30:00', 'Europe/Bucharest'], // repeated hour
    ['2026-02-29', 'UTC'], // not a leap year
    ['2026-01-01T24:00', 'UTC'],
    ['2026-01-01T24:00:01', 'UTC'],
    ['2026-01-01T10:00:59.9999999Z', 'UTC'],
    ['2026-01-01T10:00:00,5+05:45', 'UTC'],
  ])('agrees with the lenient reader on %s in %s', (text, zone) => {
    const lenient = readLenientISO(text, zone)?.epochMilliseconds;
    const fast = readCommonISO(text, () => zone);
    if (fast !== undefined) expect(fast).toBe(lenient);
  });
});
