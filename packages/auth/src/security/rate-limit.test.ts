import { afterAll, describe, expect, it } from 'vitest';

import { KV } from '@arki/kv';
import { RateLimitExceededError } from '@arki/kv/errors';

import { ensureRateLimitNotExceeded } from './rate-limit';

// Nothing listens on port 1, so KV falls back to its in-memory limiter: the real
// rate-limiter-flexible behavior, without a Redis server.
const kv = new KV('redis://127.0.0.1:1');

afterAll(async () => {
  await kv.close();
});

describe('ensureRateLimitNotExceeded', () => {
  // A limit of N must let N sign-in attempts through. Refusing the Nth locks real users out early;
  // letting the (N+1)th through, or failing it with a non-Error, breaks callers that catch the typed error.
  it('allows exactly `limit` attempts, then refuses with RateLimitExceededError', async () => {
    const key = `user-${crypto.randomUUID()}@app.test`;

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(ensureRateLimitNotExceeded(kv, key, 3, 60)).resolves.toBeUndefined();
    }

    await expect(ensureRateLimitNotExceeded(kv, key, 3, 60)).rejects.toBeInstanceOf(RateLimitExceededError);
    await expect(ensureRateLimitNotExceeded(kv, key, 3, 60)).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  // Each key is its own bucket: one user hitting the limit must not lock out another.
  it('keeps separate buckets per key', async () => {
    const blocked = `blocked-${crypto.randomUUID()}@app.test`;
    const other = `other-${crypto.randomUUID()}@app.test`;

    await ensureRateLimitNotExceeded(kv, blocked, 1, 60);
    await expect(ensureRateLimitNotExceeded(kv, blocked, 1, 60)).rejects.toBeInstanceOf(RateLimitExceededError);

    await expect(ensureRateLimitNotExceeded(kv, other, 1, 60)).resolves.toBeUndefined();
  });
});
