/**
 * Test fixture, not shipped: an in-memory key-value store with TTLs on a test
 * clock. It has the `@arki/kv` `KV` methods the nonce and receipt stores use.
 */
import type { Clock } from '@arki/clock';

type Entry = { value: unknown; expiresAt: number | undefined };

export function memoryKv(clock: Clock) {
  const entries = new Map<string, Entry>();
  const live = (key: string): Entry | undefined => {
    const entry = entries.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= clock.now().getTime()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  const expiry = (seconds: number | undefined) =>
    seconds === undefined ? undefined : clock.now().getTime() + seconds * 1000;
  return {
    entries,
    get: (key: string): Promise<unknown> => Promise.resolve(structuredClone(live(key)?.value)),
    set: (key: string, value: unknown, expirationSeconds?: number): Promise<boolean> => {
      entries.set(key, { value: structuredClone(value), expiresAt: expiry(expirationSeconds) });
      return Promise.resolve(true);
    },
    setIfNotExists: (key: string, value: unknown, expirationSeconds: number): Promise<boolean> => {
      if (live(key) !== undefined) return Promise.resolve(false);
      entries.set(key, { value, expiresAt: expiry(expirationSeconds) });
      return Promise.resolve(true);
    },
  };
}
