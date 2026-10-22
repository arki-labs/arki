import { afterEach, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';
import { UnexpectedDefect } from '@arki/failure';

import { routes, rpcMount } from '../bundle.js';
import { createClient } from '../client.js';
import { requestContext } from '../context.js';
import { route } from '../contract.js';
import { buildEngine } from '../compiled.js';
import { HTTP_SERVER_FAILURES } from '../failures.js';
import { idempotencyOwnerId, requestId } from '../ids.js';
import { step } from '../middleware.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('request identities', () => {
  it('leaves raw mounts and unmatched routes independent of base request identities', async () => {
    vi.stubGlobal('crypto', null);
    const engine = buildEngine([
      routes().mount(
        '/raw',
        () => {
          expect(requestContext()).toBeUndefined();
          return new Response('raw');
        },
        { id: 'raw' },
      ),
    ], { requestContext: true });

    const response = await engine.fetch(new Request('http://test/raw'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('raw');
    const missing = await engine.fetch(new Request('http://test/missing'));
    expect(missing.status).toBe(404);
  });

  it('generates the existing UUID format through the canonical declaration', async () => {
    const uuid = '2d128456-0aef-4f1e-a1bd-123456789abc';
    const randomUUID = vi.fn(() => uuid);
    vi.stubGlobal('crypto', { randomUUID });
    const endpoint = route.get('/request', { id: 'request', output: requestId.schema });
    const engine = buildEngine([
      routes().bind(endpoint, (_input, ctx) => {
        expect(requestContext()?.requestId).toBe(ctx.requestId);
        return ctx.requestId;
      }),
    ], { requestContext: true });

    const response = await engine.fetch(new Request('http://test/request'));
    expect(response.status).toBe(200);
    expect(await response.json()).toBe(uuid);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(requestContext()).toBeUndefined();
  });

  it.each(['', 'legacy:request/7'])('preserves present header %j without requiring entropy', async supplied => {
    vi.stubGlobal('crypto', null);
    const sync = route.get('/sync', { id: 'sync', output: requestId.schema });
    const async = route.get('/async', { id: 'async', output: requestId.schema });
    const engine = buildEngine([
      routes().bind(sync, (_input, ctx) => ctx.requestId),
      routes()
        .use(step(() => ({ marker: 'ready' })))
        .bind(async, async (_input, ctx) => {
          await Promise.resolve();
          expect(requestContext()?.requestId).toBe(ctx.requestId);
          return ctx.requestId;
        }),
      routes().rpc(rpcMount('/rpc', { id: 'rpc' }), {
        context: (_req, ctx) => ({ requestId: ctx.requestId }),
        handle: (_req, ctx) => Response.json(ctx.requestId),
      }),
    ], { requestContext: true });

    for (const path of ['/sync', '/async', '/rpc']) {
      const response = await engine.fetch(new Request(`http://test${path}`, { headers: { 'x-request-id': supplied } }));
      expect(response.status).toBe(200);
      expect(await response.json()).toBe(supplied);
    }
    expect(requestContext()).toBeUndefined();
  });

  it.each([null, undefined, {}])(
    'refuses every bound execution path before handlers, steps or RPC context with unusable crypto %j',
    async cryptoProvider => {
      vi.stubGlobal('crypto', cryptoProvider);
      const handler = vi.fn(() => {
        throw new Error('The handler must not run without request entropy.');
      });
      const marker = vi.fn(() => ({ marker: 'ready' }));
      const context = vi.fn(() => ({}));
      const handle = vi.fn(() => new Response('unreachable'));
      const engine = buildEngine([
        routes().bind(route.get('/sync', { id: 'sync' }), handler),
        routes()
          .use(step(marker))
          .bind(route.get('/derived', { id: 'derived' }), handler),
        routes().bind(route.post('/body', { id: 'body', body: requestId.schema }), handler),
        routes().rpc(rpcMount('/rpc', { id: 'rpc' }), { context, handle }),
      ]);

      for (const path of ['/sync', '/derived', '/body', '/rpc']) {
        const response = await engine.fetch(
          new Request(`http://test${path}`, { method: path === '/body' ? 'POST' : 'GET' }),
        );
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ error: { code: RandomSourceUnavailable.code } });
      }
      for (const callback of [handler, marker, context, handle]) expect(callback).not.toHaveBeenCalled();
      expect(requestContext()).toBeUndefined();
    },
  );

  it('revives request setup failures on a route without route-owned failures', async () => {
    vi.stubGlobal('crypto', null);
    const endpoint = route.get('/request', { id: 'request', output: requestId.schema });
    const handler = vi.fn(() => requestId.schema.parse('unreachable'));
    const engine = buildEngine([routes().bind(endpoint, handler)]);
    const call = createClient(endpoint, {
      baseUrl: 'http://test',
      fetch: (url, init) => engine.fetch(new Request(url, init)),
    });

    expect(RandomSourceUnavailable.is(await call())).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['development', 'production'])(
    'redacts provider faults in %s and revives their exact canonical failure',
    async mode => {
      vi.stubEnv('NODE_ENV', mode);
      const randomUUID = vi.fn(() => {
        throw new Error('private-provider-token');
      });
      vi.stubGlobal('crypto', { randomUUID });
      const endpoint = route.get('/request', { id: 'request', output: requestId.schema });
      const handler = vi.fn(() => requestId.schema.parse('unreachable'));
      const engine = buildEngine([routes().bind(endpoint, handler)]);

      const response = await engine.fetch(new Request('http://test/request'));
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain(UnexpectedDefect.code);
      expect(body).not.toContain('private-provider-token');

      const call = createClient(endpoint, {
        baseUrl: 'http://test',
        fetch: (url, init) => engine.fetch(new Request(url, init)),
      });
      const failure = await call();
      expect(UnexpectedDefect.is(failure)).toBe(true);
      expect(JSON.stringify(failure)).not.toContain('private-provider-token');
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('keeps standalone creation failures exact and success schemas free of failures', () => {
    vi.stubGlobal('crypto', null);
    expect(HTTP_SERVER_FAILURES).toEqual([RandomSourceUnavailable, UnexpectedDefect]);
    expect(RandomSourceUnavailable.is(requestId.create())).toBe(true);
    expect(RandomSourceUnavailable.is(idempotencyOwnerId.create())).toBe(true);
    expect(requestId.schema.safeParse(RandomSourceUnavailable()).success).toBe(false);
  });
});
