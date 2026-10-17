import { describe, expect, test, vi } from 'vitest';

import { isFailure } from '@arki/failure';

import { RateLimited } from '../failures';
import { createRateLimitedFunction, RateLimiter } from './rate-limiter';

// One request per minute and a single attempt, so the second call meets a full window without waiting.
const config = { maxRequests: 1, windowMs: 60_000, maxRetries: 1 };

describe('RateLimiter.execute', () => {
  test('returns the plain value while the window has room', async () => {
    const limiter = new RateLimiter(config);

    expect(await limiter.execute('key', () => Promise.resolve('ok'))).toBe('ok');
  });

  test('returns RateLimited for a full window, so the caller can wait retryAfterMs instead of catching', async () => {
    const limiter = new RateLimiter(config);
    await limiter.execute('key', () => Promise.resolve('first'));
    const fn = vi.fn(() => Promise.resolve('second'));

    const result = await limiter.execute('key', fn);

    expect(RateLimited.is(result)).toBe(true);
    if (!RateLimited.is(result)) return;
    expect(result.code).toBe('ai.rate_limited');
    expect(result.status).toBe(429);
    expect(result.data.retryAfterMs).toBeGreaterThan(0);
    expect(result.data.retryAfterMs).toBeLessThanOrEqual(config.windowMs);
    // A refused call must not reach the provider.
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('createRateLimitedFunction', () => {
  test('resolves to RateLimited instead of rejecting when the limit is busy', async () => {
    const limited = createRateLimitedFunction((name: string) => Promise.resolve(`hi ${name}`), config);

    const first = await limited('ada');
    const second = await limited('bob');

    expect(first).toBe('hi ada');
    expect(isFailure(second)).toBe(true);
    expect(RateLimited.is(second)).toBe(true);
  });
});
