import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

import type { ResponseCache } from '../idempotency.js';
import { routes, rpcMount } from '../bundle.js';
import { createClient } from '../client.js';
import { route } from '../contract.js';
import { derive } from '../derive.js';
import { buildEngine } from '../compiled.js';
import { composeMiddleware } from '../engine.js';
import { IDEMPOTENCY_FAILURES, IdempotencyKeyRequired, idempotent } from '../idempotency.js';

const SignIn = defineFailure('test.sign_in', { status: 401 });
const Limited = defineFailure('test.limited', { status: 429 });
const auth = derive('principal', request => (request.headers.has('authorization') ? { id: 'u1' } : SignIn()), {
  failureHeaders: () => ({ 'www-authenticate': 'Bearer' }),
});
const privateRoute = route.get('/private', { id: 'private', output: z.string(), failures: [SignIn] });
const plain = route.get('/plain', { id: 'plain', output: z.string() });
const cache: ResponseCache = {
  begin: () => Promise.resolve('started'),
  finish: () => Promise.resolve(),
  abandon: () => Promise.resolve(),
};

function declarationErrors() {
  routes()
    .derive(auth)
    // @ts-expect-error -- a returned auth failure must be listed on the boundary
    .bind(plain, () => 'hidden');
  const limited = routes()
    .derive(auth)
    .derive('quota', () => Limited());
  // @ts-expect-error -- SignIn alone does not cover the accumulated limiter refusal
  limited.bind(privateRoute, () => 'hidden');
  routes()
    .derive(auth)
    // @ts-expect-error -- SSE can refuse before emitting and must declare that refusal
    .bind(route.sse('/events', { id: 'events', event: z.string() }), async function* () {
      yield 'hidden';
    });
  routes()
    .derive(auth)
    // @ts-expect-error -- typed RPC mounts must also cover the accumulated auth refusal
    .rpc(rpcMount('/rpc', { id: 'rpc' }), { context: () => ({}), handle: () => Response.json(null) });
  // @ts-expect-error -- a descriptor without middleware failure refs cannot be protected
  idempotent({ cache, ttl: 10, scope: () => 'u1', routes: [plain] });
  idempotent({
    cache,
    ttl: 10,
    scope: () => 'u1',
    // @ts-expect-error -- one middleware definition does not cover all idempotency outcomes
    routes: [route.post('/partial', { id: 'partial', failures: [IdempotencyKeyRequired] })],
  });
  const mixedContract = Math.random() > 0.5 ? privateRoute : plain;
  routes()
    .derive(auth)
    // @ts-expect-error -- a union cannot hide an undeclared deriver failure on one possible contract
    .bind(mixedContract, () => 'hidden');
  derive('choice', () => (Math.random() > 0.5 ? SignIn() : Limited()), {
    // @ts-expect-error -- a transport callback must handle every failure its deriver returns
    failureHeaders: (_failure: ReturnType<typeof SignIn>) => ({ 'www-authenticate': 'Bearer' }),
  });
  const complete = route.post('/complete', { id: 'complete', failures: IDEMPOTENCY_FAILURES });
  const mixed = [complete, plain];
  // @ts-expect-error -- widening a mixed array must not hide its incomplete member
  idempotent({ cache, ttl: 10, scope: () => 'u1', routes: mixed });
}

describe('declared deriver and middleware failures', () => {
  it('rejects omitted and partial boundary declarations without widening context values', () => {
    expectTypeOf(declarationErrors).toBeFunction();
    routes()
      .derive(auth)
      .bind(privateRoute, (_input, context) => {
        expectTypeOf(context.principal).toEqualTypeOf<{ id: string }>();
        return context.principal.id;
      });
  });

  it('short-circuits before subsequent derivers or handlers and preserves the challenge', async () => {
    let later = 0;
    let handled = 0;
    const engine = buildEngine([
      routes()
        .derive(auth)
        .derive('later', () => {
          later += 1;
          return true;
        })
        .bind(privateRoute, () => {
          handled += 1;
          return 'private';
        }),
    ]);
    const response = await engine.fetch(new Request('http://test/private'));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    const call = createClient(privateRoute, {
      baseUrl: 'http://test',
      fetch: (url, init) => engine.fetch(new Request(url, init)),
    });
    expect(SignIn.is(await call())).toBe(true);
    expect({ later, handled }).toEqual({ later: 0, handled: 0 });
  });

  it('uses bind-time deriver snapshots so a later guard cannot change an earlier public boundary', async () => {
    const engine = buildEngine([
      routes()
        .bind(plain, () => 'public')
        .derive(auth)
        .bind(privateRoute, (_input, context) => context.principal.id),
    ]);
    const publicResponse = await engine.fetch(new Request('http://test/plain'));
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.json()).toBe('public');
    const privateResponse = await engine.fetch(new Request('http://test/private'));
    expect(privateResponse.status).toBe(401);
  });

  it('keeps hand-authored bundle derivers when a binding has no builder snapshot', async () => {
    const engine = buildEngine([
      { derivers: [auth], bindings: [{ contract: privateRoute, handler: () => 'private' }], mounts: [] },
    ]);
    const response = await engine.fetch(new Request('http://test/private'));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('retains asynchronous limiter Retry-After before opening an SSE stream', async () => {
    const events = route.sse('/events', { id: 'events', event: z.string(), failures: [Limited] });
    let opened = false;
    const engine = buildEngine([
      routes()
        .derive(derive('quota', () => Promise.resolve(Limited()), { failureHeaders: () => ({ 'retry-after': '3' }) }))
        .bind(events, async function* () {
          opened = true;
          yield 'event';
        }),
    ]);
    const response = await engine.fetch(new Request('http://test/events'));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(opened).toBe(false);
  });

  it('stops a typed RPC mount before context resolution and dispatch', async () => {
    let contexts = 0;
    let handled = 0;
    const declaration = rpcMount('/rpc', { id: 'rpc', failures: [SignIn] });
    const engine = buildEngine([
      routes()
        .derive(auth)
        .rpc(declaration, {
          context: () => {
            contexts += 1;
          },
          handle: () => {
            handled += 1;
            return Response.json(null);
          },
        }),
    ]);
    const response = await engine.fetch(new Request('http://test/rpc'));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect({ contexts, handled }).toEqual({ contexts: 0, handled: 0 });
  });

  it('selects idempotency paths from the same descriptors the typed client consumes', async () => {
    const write = route.post('/write', { id: 'write', failures: IDEMPOTENCY_FAILURES });
    let handled = 0;
    const engine = buildEngine([
      routes().bind(write, () => {
        handled += 1;
      }),
    ]);
    const fetch = composeMiddleware(engine.fetch, [idempotent({ cache, ttl: 10, scope: () => 'u1', routes: [write] })]);
    const call = createClient(write, { baseUrl: 'http://test', fetch: (url, init) => fetch(new Request(url, init)) });
    expect(IdempotencyKeyRequired.is(await call())).toBe(true);
    expect(handled).toBe(0);
  });

  it('rejects an untyped descriptor missing middleware declarations at configuration', () => {
    expect(() =>
      Reflect.apply(idempotent, undefined, [{ cache, ttl: 10, scope: () => 'u1', routes: [plain] }]),
    ).toThrow('Every idempotent route must declare IDEMPOTENCY_FAILURES.');
  });
});
