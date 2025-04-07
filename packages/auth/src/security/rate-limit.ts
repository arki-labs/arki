import type { KV } from '@arki/kv';
import { RateLimitExceededError } from '@arki/kv/errors';

export const ensureRateLimitNotExceeded = async (kv: KV, key: string, limit?: number, windowSeconds?: number) => {
  const limiter = kv.getRateLimiter(`login-attempt:${key}`, {
    points: limit ?? 10,
    duration: windowSeconds ?? 60,
  });
  const result = await limiter.consume(1);

  if (result.remainingPoints === 0) {
    throw new RateLimitExceededError('Rate limit exceeded', result);
  }
};
