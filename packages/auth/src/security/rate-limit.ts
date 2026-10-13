import type { KV } from '@arki/kv';
import { RateLimitExceededError } from '@arki/kv/errors';

import { debugRateLimit } from '../debug';

export const ensureRateLimitNotExceeded = async (kv: KV, key: string, limit?: number, windowSeconds?: number) => {
  const effectiveLimit = limit ?? 10;
  const effectiveWindow = windowSeconds ?? 60;

  debugRateLimit.debug(
    '[ensureRateLimitNotExceeded] Checking rate limit (key: {key}, limit: {limit}, window: {window}s)',
    { key, limit: effectiveLimit, window: effectiveWindow },
  );

  const limiter = kv.getRateLimiter(`login-attempt:${key}`, {
    points: effectiveLimit,
    duration: effectiveWindow,
  });
  const result = await limiter.consume(1);

  debugRateLimit.debug(
    '[ensureRateLimitNotExceeded] Rate limit check result (remaining: {remaining}/{effectiveLimit})',
    { remaining: result.remainingPoints, effectiveLimit },
  );

  if (result.remainingPoints === 0) {
    debugRateLimit.debug('[ensureRateLimitNotExceeded] Rate limit exceeded for key: {key}', { key });
    throw new RateLimitExceededError('Rate limit exceeded', result);
  }
};
