/**
 * `errorCaptureMiddleware({ report })` — the app's one place that sends procedure failures to an
 * error tracker.
 *
 * Why these tests exist: capture must never change what the caller gets (the same error, even when
 * the reporter itself breaks), expected client errors must stay out of the tracker or real incidents
 * drown in normal traffic, and the reporter needs the procedure path to say where it failed.
 */
import { createRouterClient, ORPCError, os } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';

import type { ErrorCaptureInfo } from '../orpc.js';
import { errorCaptureMiddleware } from '../orpc.js';

type RequestContext = { readonly headers: Headers };

const clientThrowing = (thrown: unknown, report: (error: unknown, info: ErrorCaptureInfo) => void) => {
  const errorCapture = errorCaptureMiddleware({ report });
  const base = os.$context<RequestContext>().use(errorCapture);
  const router = {
    digest: {
      compile: base.handler(() => {
        throw thrown;
      }),
      ok: base.handler(() => 'compiled'),
    },
  };
  return createRouterClient(router, { context: { headers: new Headers() } });
};

describe('errorCaptureMiddleware', () => {
  it('reports an unexpected error with the procedure path, then rethrows the same error', async () => {
    const boom = new Error('db unavailable');
    const report = vi.fn();

    await expect(clientThrowing(boom, report).digest.compile()).rejects.toBe(boom);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(boom, { path: ['digest', 'compile'] });
  });

  it('reports a 5xx ORPCError', async () => {
    const serverError = new ORPCError('INTERNAL_SERVER_ERROR', { message: 'db unavailable' });
    const report = vi.fn();

    await expect(clientThrowing(serverError, report).digest.compile()).rejects.toBe(serverError);

    expect(report).toHaveBeenCalledWith(serverError, { path: ['digest', 'compile'] });
  });

  it.each(['UNAUTHORIZED', 'BAD_REQUEST', 'NOT_FOUND', 'TOO_MANY_REQUESTS'] as const)(
    'does not report an expected %s client error',
    async code => {
      const clientError = new ORPCError(code);
      const report = vi.fn();

      await expect(clientThrowing(clientError, report).digest.compile()).rejects.toBe(clientError);

      expect(report).not.toHaveBeenCalled();
    },
  );

  it('still rethrows the procedure error when the reporter throws', async () => {
    const boom = new Error('db unavailable');
    const report = vi.fn(() => {
      throw new Error('tracker down');
    });

    await expect(clientThrowing(boom, report).digest.compile()).rejects.toBe(boom);

    expect(report).toHaveBeenCalledTimes(1);
  });

  it('stays out of the way of a procedure that succeeds', async () => {
    const report = vi.fn();

    await expect(clientThrowing(new Error('unused'), report).digest.ok()).resolves.toBe('compiled');

    expect(report).not.toHaveBeenCalled();
  });
});
