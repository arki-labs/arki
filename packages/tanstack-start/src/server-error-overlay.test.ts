// @vitest-environment node
/**
 * The overlay sits between `startServer` and Start's handler. It must hand
 * Start the request context untouched: dropping `{ context }` would leave
 * every server route and server function without `services`, `rpc` and
 * `session`. A thrown error must still become a 500 that Sentry sees.
 */
import { describe, expect, it } from 'vitest';

import { registerSentryCapture } from './sentry-bridge';
import { withServerErrorOverlay } from './server-error-overlay';

const request = () => new Request('https://shop.example/digest');

describe('withServerErrorOverlay()', () => {
  it('passes the request context through to the inner handler', async () => {
    const context = { requestId: 'req-1' };
    const seen: unknown[] = [];
    const wrapped = withServerErrorOverlay((_request: Request, options: { readonly context: typeof context }) => {
      seen.push(options.context);
      return new Response('page');
    });

    const response = await wrapped(request(), { context });

    expect(await response.text()).toBe('page');
    expect(seen).toEqual([context]);
    expect(seen[0]).toBe(context);
  });

  it('answers a thrown error with a 500 and reports it', async () => {
    const reported: unknown[] = [];
    registerSentryCapture(error => reported.push(error));
    const boom = new Error('boom');
    const wrapped = withServerErrorOverlay(() => {
      throw boom;
    });

    const response = await wrapped(request());

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(reported).toEqual([boom]);
  });
});
