/**
 * The ambient request context is opt-in: an engine built without
 * `requestContext: true` never enters the store, and asking for the context
 * in a process whose engines all left it off is a loud configuration error.
 * Module state is per test file, so this file owns the whole lifecycle.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { routes } from '../bundle.js';
import { buildEngine } from '../compiled.js';
import { requestContext } from '../context.js';
import { route } from '../contract.js';
import { HTTP_ERROR_CODES, HttpConfigError } from '../error.js';

const whoami = route.get('/whoami', { id: 'whoami', output: z.object({ rid: z.string().nullable() }) });

describe('requestContext() opt-in', () => {
  it('is undefined before any engine exists (workers, direct handler calls)', () => {
    expect(requestContext()).toBeUndefined();
  });

  it('throws the configuration error once engines exist without the option', async () => {
    const engine = buildEngine([routes().bind(whoami, (_input, ctx) => ({ rid: ctx.requestId }))]);
    const res = await engine.fetch(new Request('http://localhost/whoami'));
    expect(res.status).toBe(200);
    expect(() => requestContext()).toThrow(HttpConfigError);
    try {
      requestContext();
    } catch (error) {
      expect(error).toMatchObject({ code: HTTP_ERROR_CODES.requestContextDisabled });
    }
  });

  it('answers inside a request once an engine opts in, and undefined outside', async () => {
    const engine = buildEngine(
      [routes().bind(whoami, (_input, ctx) => ({ rid: requestContext()?.requestId === ctx.requestId ? ctx.requestId : null }))],
      { requestContext: true },
    );
    const res = await engine.fetch(new Request('http://localhost/whoami', { headers: { 'x-request-id': 'req-9' } }));
    expect(await res.json()).toEqual({ rid: 'req-9' });
    expect(requestContext()).toBeUndefined();
  });
});
