/** A request refused by the rate limiter still gets TOO_MANY_REQUESTS (429) from the shared error middleware. */
import { call, ORPCError } from '@orpc/server';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { describe, expect, it, vi } from 'vitest';

import { publicProcedure } from './orpc';

// The shared env validates on import; these values are never connected to.
vi.hoisted(() => {
  process.env['AUTH_SECRET'] = 'test-secret-test-secret-test-secret-0123';
  process.env['DB_URL'] = 'postgres://test:test@127.0.0.1:1/test';
});

describe('errorHandlingMiddleware', () => {
  it('turns a refused rate limiter result into TOO_MANY_REQUESTS (429)', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiterMemory({ points: 1, duration: 60 });
    const procedure = publicProcedure.handler(async () => {
      await limiter.consume('ada');
      return 'ok';
    });
    const context = {} as never;
    expect(await call(procedure, undefined, { context })).toBe('ok');
    const refused = call(procedure, undefined, { context }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await refused;
    vi.useRealTimers();
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: 'TOO_MANY_REQUESTS', status: 429 });
  });
});
