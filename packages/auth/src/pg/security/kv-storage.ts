/**
 * The engine's rate limiter on the shared `@arki/kv` store. Every replica counts in one place.
 * A store failure is never a pass: it throws `ARKI_AUTH_E503`, which the handler answers with 503.
 */
import type { BetterAuthOptions } from 'better-auth';

import type { RateLimitStore } from '../types.js';
import { AUTH_ERROR_CODES, AuthError } from '../../errors.js';
import { errorField, log } from '../../log.js';

/** The engine's atomic rate-limit storage contract. */
export type RateLimitStorage = NonNullable<NonNullable<BetterAuthOptions['rateLimit']>['customStorage']>;

const LIMITER_ID = 'arki-auth';

/** The limiter refuses an over-limit attempt with its result, not an `Error`. */
function msBeforeNextOf(rejection: unknown): number | undefined {
  if (typeof rejection !== 'object' || rejection === null || rejection instanceof Error) return undefined;
  const ms: unknown = Reflect.get(rejection, 'msBeforeNext');
  return typeof ms === 'number' ? ms : undefined;
}

export function kvRateLimitStorage(store: RateLimitStore): RateLimitStorage {
  return {
    async consume(key, rule) {
      const limiter = store.getRateLimiter(LIMITER_ID, { points: rule.max, duration: rule.window });
      try {
        await limiter.consume(key);
        return { allowed: true, retryAfter: null };
      } catch (error) {
        const msBeforeNext = msBeforeNextOf(error);
        if (msBeforeNext !== undefined)
          return { allowed: false, retryAfter: Math.max(1, Math.ceil(msBeforeNext / 1000)) };
        log.error('The rate-limit store failed; the request is refused', { error: errorField(error) });
        throw new AuthError(AUTH_ERROR_CODES.storeUnavailable, 'The rate-limit store is unavailable.', {
          cause: error,
        });
      }
    },
  };
}
