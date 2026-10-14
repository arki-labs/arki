import type { KV } from '@arki/kv';
import { RateLimitExceededError } from '@arki/kv/errors';

import { debugRateLimit } from '../debug';

type LimiterResult = ConstructorParameters<typeof RateLimitExceededError>[1];

/** rate-limiter-flexible rejects an over-limit `consume` with its result object, not an Error. */
function isLimiterResult(value: unknown): value is LimiterResult {
  return typeof value === 'object' && value !== null && 'remainingPoints' in value && 'msBeforeNext' in value;
}

/**
 * Consumes one attempt for `key` and throws {@link RateLimitExceededError} once `limit` attempts
 * were made inside `windowSeconds`. Exactly `limit` attempts pass; the next one is refused.
 */
export const ensureRateLimitNotExceeded = async (kv: KV, key: string, limit = 10, windowSeconds = 60) => {

  debugRateLimit.debug(
    '[ensureRateLimitNotExceeded] Checking rate limit (key: {key}, limit: {limit}, window: {window}s)',
    { key, limit, window: windowSeconds },
  );

  // One limiter per (limit, window), with `key` as the bucket. Building a limiter per key would
  // cache one limiter object per caller-supplied key inside KV for the life of the process.
  const limiter = kv.getRateLimiter('login-attempt', {
    points: limit,
    duration: windowSeconds,
  });

  try {
    const result = await limiter.consume(key);
    debugRateLimit.debug(
      '[ensureRateLimitNotExceeded] Rate limit check result (remaining: {remaining}/{limit})',
      { remaining: result.remainingPoints, limit },
    );
  } catch (error) {
    // rate-limiter-flexible rejects an over-limit consume with its result, not an Error.
    if (isLimiterResult(error)) {
      debugRateLimit.debug('[ensureRateLimitNotExceeded] Rate limit exceeded for key: {key}', { key });
      throw new RateLimitExceededError('Rate limit exceeded', error);
    }
    throw error;
  }
};
