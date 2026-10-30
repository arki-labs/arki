/**
 * `getRateLimiter(id, options)` reuses a limiter when the id and `JSON.stringify(options)` match.
 * It compares primitive options field by field first, so these tests pin that the fast comparison
 * and the JSON fallback agree on every case where they could part ways.
 *
 * The Redis URL points at a closed local port, so every limiter is the in-memory fallback and no
 * traffic leaves the machine.
 */

import type { IRateLimiterOptions } from 'rate-limiter-flexible';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KV } from './index.js';

let kv: KV;

beforeAll(() => {
  kv = new KV('redis://127.0.0.1:1', 'test', 'rl');
});

afterAll(async () => {
  expect(await kv.close()).toBeUndefined();
});

const get = (id: string, options: Partial<IRateLimiterOptions>) => kv.getRateLimiter(id, options);

describe('KV.getRateLimiter() cache', () => {
  it('returns the same limiter for the same id and equal options in a new object', () => {
    expect(get('same', { points: 5, duration: 1 })).toBe(get('same', { points: 5, duration: 1 }));
  });

  it('returns a new limiter when an option value differs', () => {
    expect(get('value', { points: 5, duration: 1 })).not.toBe(get('value', { points: 6, duration: 1 }));
  });

  it('keeps one limiter per distinct options under the same id', () => {
    const five = get('several', { points: 5 });
    const six = get('several', { points: 6 });
    expect(get('several', { points: 5 })).toBe(five);
    expect(get('several', { points: 6 })).toBe(six);
  });

  it('returns a new limiter for the same options under another id', () => {
    expect(get('id-a', { points: 5 })).not.toBe(get('id-b', { points: 5 }));
  });

  it('treats key order as JSON does: a different order is different options', () => {
    expect(get('order', { points: 5, duration: 1 })).not.toBe(get('order', { duration: 1, points: 5 }));
  });

  it('treats an undefined option as absent, as JSON does', () => {
    expect(get('undefined', { points: 5 })).toBe(get('undefined', { points: 5, duration: undefined }));
  });

  it('treats NaN and null as equal, as JSON does', () => {
    // `execEvenlyMinDelayMs` is only read when `execEvenly` is on, so the limiter accepts NaN here.
    const nan = get('nan', { points: 5, execEvenlyMinDelayMs: Number.NaN });
    expect(get('nan', { points: 5, execEvenlyMinDelayMs: null as unknown as number })).toBe(nan);
  });

  it('compares object-valued options by their JSON', () => {
    // `extra` is not a limiter option; the in-memory limiter ignores it, the cache key does not.
    const options = (name: string) => ({ points: 5, extra: { name } });
    const first = get('object', options('a'));
    expect(get('object', options('a'))).toBe(first);
    expect(get('object', options('b'))).not.toBe(first);
  });

  it('honours a toJSON method on the options', () => {
    const plain = get('to-json', { points: 5 });
    const rewritten = { points: 5, toJSON: () => ({ points: 7 }) };
    expect(get('to-json', rewritten)).not.toBe(plain);
    expect(get('to-json', { points: 7 })).toBe(get('to-json', rewritten));
  });

  it('reuses the limiter it built, so consumed points carry over', async () => {
    const options = { points: 10, duration: 60 };
    await get('carry', options).consume('user');
    const result = await get('carry', { ...options }).consume('user');
    expect(result.consumedPoints).toBe(2);
  });
});
