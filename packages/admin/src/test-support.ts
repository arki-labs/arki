/**
 * Test fixture, not shipped: an in-memory key-value store with TTLs on a test
 * clock. It has the `@arki/kv` `KV` methods the nonce and receipt stores use.
 */
import type { Clock } from '@arki/clock';
import { isFailure } from '@arki/failure';
import type { StandardSchemaV1 } from '@arki/schema';
import { parse } from '@arki/schema';

import { wireCodeOf } from './failures.ts';

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
    get: <Output>(key: string, schema: StandardSchemaV1<unknown, Output>) => {
      const value: unknown = structuredClone(live(key)?.value);
      return Promise.resolve(value === undefined ? undefined : parse(schema, value));
    },
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

/**
 * Awaits a call that must come back refused. Answers the failure, its message, and the stable
 * `ARKI_ADMIN_E0NN` code it travelled under on the wire (the failure's own code for any other failure).
 */
export async function refusal(promise: Promise<unknown>) {
  const result = await promise;
  if (!isFailure(result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return { failure: result, code: wireCodeOf(result.code) ?? result.code, message: result.message };
}
