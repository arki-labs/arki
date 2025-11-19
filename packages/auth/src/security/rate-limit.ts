import type { KV } from '@arki/kv';
import { RateLimitExceededError } from '@arki/kv/errors';

import { debugRateLimit } from '../debug';

export const ensureRateLimitNotExceeded = async (kv: KV, key: string, limit?: number, windowSeconds?: number) => {
  const effectiveLimit = limit ?? 10;
  const effectiveWindow = windowSeconds ?? 60;

  debugRateLimit('[ensureRateLimitNotExceeded] Checking rate limit (key: %s, limit: %d, window: %ds)',
    key, effectiveLimit, effectiveWindow);

  const limiter = kv.getRateLimiter(`login-attempt:${key}`, {
    points: effectiveLimit,
    duration: effectiveWindow,
  });
  const result = await limiter.consume(1);

  debugRateLimit('[ensureRateLimitNotExceeded] Rate limit check result (remaining: %d/%d)',
    result.remainingPoints, effectiveLimit);

  if (result.remainingPoints === 0) {
    debugRateLimit('[ensureRateLimitNotExceeded] Rate limit exceeded for key: %s', key);
    throw new RateLimitExceededError('Rate limit exceeded', result);
  }
};
