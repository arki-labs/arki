/**
 * The compiled engine's own router, and what it leaves to the Hono engine.
 * Every route must answer the same whichever engine matched it; these
 * tests pin the cases where the two routers could disagree.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { routes, rpcMount } from '../bundle.js';
import { buildEngine } from '../compiled.js';
import { route } from '../contract.js';
import type { Engine } from '../engine.js';
import { buildHonoEngine, composeMiddleware } from '../engine.js';
import { listen } from '../listen.js';
import { optional } from '../wire.js';

const BASE = 'http://localhost';
const Echo = z.object({ via: z.string(), id: z.string().optional() });

const get = (engine: { fetch: (req: Request) => Promise<Response> }, path: string) =>
  engine.fetch(new Request(`${BASE}${path}`));
const getJson = async (engine: { fetch: (req: Request) => Promise<Response> }, path: string): Promise<unknown> => {
  const res = await get(engine, path);
  return res.json();
};
/** The Bun route handler the engine offers for `method path`; fails the test when there is none. */
function bunHandler(engine: Engine, path: string, method: string) {
  const handler = engine.bunRoutes?.[path]?.[method];
  if (handler === undefined) throw new Error(`no Bun route for ${method} ${path}`);
  return handler;
}

describe('compiled router vs Hono: same answers', () => {
  const bundles = [
    routes()
      .bind(route.get('/users/me', { id: 'users.me', output: Echo }), () => ({ via: 'me' }))
      .bind(route.get('/users/:id/posts', { id: 'users.posts', params: { id: z.string() }, output: Echo }), ({ params }) => ({
        via: 'posts',
        id: params.id,
      }))
      .bind(route.get('/users/:id', { id: 'users.get', params: { id: z.string() }, output: Echo }), ({ params }) => ({
        via: 'user',
        id: params.id,
      }))
      .bind(route.get('/opt/:x?', { id: 'opt', params: { x: optional(z.string()) }, output: Echo }), ({ params }) => ({
        via: 'opt',
        ...(params.x === undefined ? {} : { id: params.x }),
      })),
  ];
  const compiled = buildEngine(bundles);
  const hono = buildHonoEngine(bundles);

  it.each([
    ['/users/me', 200, { via: 'me' }],
    ['/users/me/posts', 200, { via: 'posts', id: 'me' }], // static "me" dead-ends; backtracks to :id
    ['/users/u%20x', 200, { via: 'user', id: 'u x' }], // percent-decoded param
    ['/users/me/', 404, undefined], // trailing slash is a different path
    ['/opt', 200, { via: 'opt' }], // optional placeholder: served by Hono behind the trie
    ['/opt/7', 200, { via: 'opt', id: '7' }],
    ['/nope', 404, undefined],
  ])('%s → %i', async (path, status, body) => {
    const [a, b] = await Promise.all([get(compiled, path), get(hono, path)]);
    expect(a.status).toBe(status);
    expect(b.status).toBe(status);
    if (body !== undefined) {
      expect(await a.json()).toEqual(body);
      expect(await b.json()).toEqual(body);
    }
  });

  it('lists route ids in declaration order and offers the trie routes to Bun', () => {
    expect(compiled.routeIds).toEqual(['users.me', 'users.posts', 'users.get', 'opt']);
    expect(Object.keys(compiled.bunRoutes ?? {})).toEqual(['/users/me', '/users/:id/posts', '/users/:id']);
    expect(hono.bunRoutes).toBeUndefined();
  });

  it('answers a Bun-matched request from its params, the same as fetch', async () => {
    const req = Object.assign(new Request(`${BASE}/users/42`), { params: { id: '42' } });
    const res = await bunHandler(compiled, '/users/:id', 'GET')(req);
    expect(await res.json()).toEqual({ via: 'user', id: '42' });
  });
});

describe('what stays with Hono', () => {
  it('leaves routes under a mount prefix to Hono, so the mount keeps its priority', async () => {
    const mountHits: string[] = [];
    const engine = buildEngine([
      routes()
        .mount(
          '/api',
          req => {
            mountHits.push(new URL(req.url).pathname);
            return Response.json({ via: 'mount' });
          },
          { id: 'api' },
        )
        .bind(route.get('/api/ping', { id: 'api.ping', output: Echo }), () => ({ via: 'route' })),
    ]);
    expect(engine.bunRoutes).toBeUndefined();
    const res = await get(engine, '/api/ping');
    expect(await res.json()).toEqual({ via: 'mount' });
    expect(mountHits).toEqual(['/ping']); // the mount sees the stripped path, as before
  });

  it('rejects a duplicate route across the two routers with the engine error', () => {
    expect(() =>
      buildEngine([
        routes().bind(route.get('/a/:x', { id: 'one', params: { x: z.string() }, output: Echo }), () => ({ via: '1' })),
        routes().bind(route.get('/a/:x?', { id: 'two', params: { x: optional(z.string()) }, output: Echo }), () => ({
          via: '2',
        })),
      ]),
    ).toThrow(/duplicate route GET \/a\/:x\?/);
  });

  it('serves an rpc mount and a route beside it', async () => {
    const engine = buildEngine([
      routes()
        .bind(route.get('/ping', { id: 'ping', output: Echo }), () => ({ via: 'route' }))
        .rpc(rpcMount('/rpc', { id: 'rpc' }), { context: () => ({}), handle: () => Response.json({ via: 'rpc' }) }),
    ]);
    expect(engine.routeIds).toEqual(['rpc', 'ping']);
    expect(await getJson(engine, '/ping')).toEqual({ via: 'route' });
    expect(await getJson(engine, '/rpc/anything')).toEqual({ via: 'rpc' });
  });
});

describe('middleware around an engine', () => {
  const engine = buildEngine([
    routes().bind(route.get('/users/:id', { id: 'users.get', params: { id: z.string() }, output: Echo }), ({ params }) => ({
      via: 'user',
      id: params.id,
    })),
  ]);

  it('wraps fetch and every Bun route handler', async () => {
    const seen: string[] = [];
    const served = composeMiddleware(engine, [
      async (req, next) => {
        seen.push(req.url);
        const res = await next(req);
        res.headers.set('x-layer', 'yes');
        return res;
      },
    ]);
    const viaFetch = await served.fetch(new Request(`${BASE}/users/1`));
    const bunReq = Object.assign(new Request(`${BASE}/users/2`), { params: { id: '2' } });
    const viaBun = await bunHandler(served, '/users/:id', 'GET')(bunReq);
    expect([viaFetch.headers.get('x-layer'), viaBun.headers.get('x-layer')]).toEqual(['yes', 'yes']);
    expect(await viaBun.json()).toEqual({ via: 'user', id: '2' });
    expect(seen).toEqual([`${BASE}/users/1`, `${BASE}/users/2`]);
    expect(served.routeIds).toEqual(engine.routeIds);
  });

  it('routes a Bun-matched request itself when a layer forwards a different Request', async () => {
    const served = composeMiddleware(engine, [(_req, next) => next(new Request(`${BASE}/users/other`))]);
    const bunReq = Object.assign(new Request(`${BASE}/users/2`), { params: { id: '2' } });
    const res = await bunHandler(served, '/users/:id', 'GET')(bunReq);
    expect(await res.json()).toEqual({ via: 'user', id: 'other' });
  });
});

describe('listen under Bun', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hands the engine routes to Bun.serve and the fetch for the rest', async () => {
    const engine = buildEngine([
      routes().bind(route.get('/ping', { id: 'ping', output: Echo }), () => ({ via: 'route' })),
    ]);
    const serve = vi.fn((_options: Record<string, unknown>) => ({ port: 1, hostname: '127.0.0.1', stop: vi.fn() }));
    vi.stubGlobal('Bun', { serve });
    await listen(engine, { port: 1 });
    expect(serve).toHaveBeenCalledWith(expect.objectContaining({ port: 1, fetch: engine.fetch, routes: engine.bunRoutes }));

    await listen(engine.fetch, { port: 1 });
    expect(serve.mock.calls[1]?.[0]).not.toHaveProperty('routes');
  });
});
