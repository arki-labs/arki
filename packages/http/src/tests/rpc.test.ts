/**
 * RPC mounts through the composed fetch handler — no sockets.
 * The static/boot split (contract at module level, handlers bound in
 * boot), deriver-fed context factories, dispatch, error envelopes,
 * mount-prefix collisions, and the manifest declaration (`toDotAction`).
 */

import { describe, expect, it } from 'vitest';

import { routes, rpcMount } from '../bundle.js';
import { buildEngine } from '../engine.js';
import { HTTP_ERROR_CODES, HttpConfigError, HttpError } from '../error.js';

const BASE = 'http://test.local';

describe('rpc mounts', () => {
  it('runs bundle derivers before dispatch and feeds the typed context factory', async () => {
    const ordersRpc = rpcMount('/rpc/orders', { id: 'orders.rpc' });

    const engine = buildEngine([
      routes()
        .derive('principal', req => req.headers.get('x-user') ?? 'anonymous')
        .rpc(ordersRpc, {
          context: (_req, ctx) => ({ user: ctx.principal, scope: 'orders' }),
          handle: (_req, ctx) => Response.json({ dispatchedAs: ctx.user, scope: ctx.scope }),
        }),
    ]);

    const res = await engine.fetch(new Request(`${BASE}/rpc/orders/anything`, { headers: { 'x-user': 'u_1' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatchedAs: 'u_1', scope: 'orders' });
    expect(engine.routeIds).toEqual(['orders.rpc']);
  });

  it('hands the ORIGINAL request to the handler — no Hono mount-path rewrite', async () => {
    // oRPC/tRPC fetch adapters take the mount path as their own
    // `prefix`/`endpoint` option; a prefix-stripped URL can never match it.
    const apiRpc = rpcMount('/api/orpc', { id: 'api.rpc' });

    const engine = buildEngine([
      routes().rpc(apiRpc, {
        context: req => ({ contextPath: new URL(req.url).pathname }),
        handle: (req, ctx) =>
          Response.json({ handlePath: new URL(req.url).pathname, contextPath: ctx.contextPath }),
      }),
    ]);

    const res = await engine.fetch(new Request(`${BASE}/api/orpc/audience/detect`, { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      handlePath: '/api/orpc/audience/detect',
      contextPath: '/api/orpc/audience/detect',
    });
  });

  it('envelopes a context-factory failure with its coded error', async () => {
    const guarded = rpcMount('/rpc/guarded', { id: 'guarded.rpc' });

    const engine = buildEngine([
      routes().rpc(guarded, {
        context: () => {
          throw new HttpError(401, HTTP_ERROR_CODES.unauthorized, 'no session');
        },
        handle: () => Response.json({ reached: true }),
      }),
    ]);
    const res = await engine.fetch(new Request(`${BASE}/rpc/guarded`));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe(HTTP_ERROR_CODES.unauthorized);
  });

  it('rejects an rpc prefix colliding with a raw mount', () => {
    const colliding = rpcMount('/rpc', { id: 'colliding.rpc' });
    const bundle = routes()
      .mount('/rpc', () => new Response('raw'), { id: 'raw.mount' })
      .rpc(colliding, { context: () => ({}), handle: () => new Response('ok') });

    expect(() => buildEngine([bundle])).toThrow(HttpConfigError);
  });

  it('is a static ActionSource: declares the mount attributed to its path', () => {
    const contract = rpcMount('/rpc/orders', {
      id: 'orders.rpc',
      transport: 'trpc',
      summary: 'Orders RPC surface',
    });

    expect(contract.toDotAction()).toEqual({
      id: 'orders.rpc',
      binding: 'trpc',
      direction: 'in',
      address: '/rpc/orders',
      summary: 'Orders RPC surface',
      metaSchema: '@arki/http/action-meta@1',
      meta: { path: '/rpc/orders', rpc: true },
    });
  });

  it('defaults the manifest binding to orpc and validates the mount path', () => {
    const contract = rpcMount('/rpc', { id: 'default.rpc' });
    expect(contract.toDotAction().binding).toBe('orpc');

    expect(() => rpcMount('rpc without slash', { id: 'bad.rpc' })).toThrow(HttpConfigError);
  });
});
