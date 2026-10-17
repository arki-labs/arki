/**
 * Rate-limit stores for the limiter tests: one shared like Redis behind `@arki/kv`, and one whose
 * backend is down.
 */
import type { RateLimiterRes } from 'rate-limiter-flexible';
import { RateLimiterMemory } from 'rate-limiter-flexible';

import type { RateLimitStore } from '../pg/types.js';

/** One shared counter per limiter shape, like Redis behind `@arki/kv`. */
export function sharedStore(): RateLimitStore {
  const limiters = new Map<string, RateLimiterMemory>();
  return {
    getRateLimiter: (id, { points = 1, duration = 1 }) => {
      const key = `${id}:${points}:${duration}`;
      const limiter = limiters.get(key) ?? new RateLimiterMemory({ points, duration, keyPrefix: key });
      limiters.set(key, limiter);
      return limiter;
    },
  };
}

class FailingLimiter extends RateLimiterMemory {
  override consume(): Promise<RateLimiterRes> {
    return Promise.reject(new Error('redis is down'));
  }
}

/** A store whose every count fails, as when Redis is down. */
export const failingStore = (): RateLimitStore => ({
  getRateLimiter: () => new FailingLimiter({ points: 1, duration: 1 }),
});
