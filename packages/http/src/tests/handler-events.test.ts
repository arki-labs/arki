/**
 * Why: a route a Dot feature mounts must show up in the app's handler events
 * (`logHandlers()`, `reportErrors()`), with the outcome an operator needs. A
 * refusal (401, 404, ...) is traffic, not a bug, so it must arrive as
 * `completed/refused` WITH its Failure; by the time it is a Response the
 * Failure is gone, so the engine hands it to the observer itself. A throw is
 * `failed` while the client still gets the 500 envelope. With nobody
 * observing, responses must be exactly what they were.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { DotLifecycleEvent } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { defineApp } from '@arki/dot/unit';
import { defineFailure, isFailure, orThrow } from '@arki/failure';

import { routes, rpcMount } from '../bundle.js';
import { route } from '../contract.js';
import { endpoints, http } from '../dot.js';
import { step } from '../middleware.js';

const SignIn = defineFailure('test.sign_in', { status: 401 });
const Missing = defineFailure('test.missing', { status: 404 });

const ping = route.get('/ping', { id: 'ping', output: z.string() });
const mine = route.get('/mine', { id: 'mine', output: z.string(), failures: [SignIn] });
const find = route.get('/find', { id: 'find', output: z.string(), failures: [Missing] });
const boom = route.get('/boom', { id: 'boom', output: z.string() });
const slow = route.get('/slow', { id: 'slow', output: z.string() });
const gateway = rpcMount('/rpc', { id: 'gateway.rpc', failures: [SignIn] });

const signedIn = (ctx: { readonly req: Request }) => (ctx.req.headers.has('authorization') ? { id: 'u1' } : SignIn());

const core = defineFeature('shop');
const shop = core.entrypoints(
  endpoints(
    core,
    () =>
      routes()
        .bind(ping, () => 'pong')
        .bind(find, () => Missing())
        .bind(boom, () => {
          throw new Error('kaput');
        })
        .bind(slow, async () => {
          await Promise.resolve();
          return 'later';
        })
        .use(step(signedIn))
        .bind(mine, () => 'mine')
        .rpc(gateway, {
          context: () => ({}),
          handle: () => Response.json({ ok: true }),
        }),
    { contracts: [ping, find, boom, slow, mine] },
  ),
);

async function boot(events?: DotLifecycleEvent[]) {
  const app = await orThrow(
    defineApp('handler-events')
      .features([shop])
      .entrypoints(http({ port: 0 }))
      .boot(),
  );
  if (events !== undefined) app.subscribe(event => events.push(event));
  const call = async (path: string, headers?: Record<string, string>) => {
    const response = await app.services.httpServer.fetch(new Request(`http://in-process${path}`, { headers }));
    return { status: response.status, text: await response.text() };
  };
  return { app, call };
}

const statusOf = (pending: Promise<{ readonly status: number }>) => pending.then(({ status }) => status);

const handlerEvents = (events: readonly DotLifecycleEvent[]) =>
  events.flatMap(event => (event.kind === 'handler' ? [event] : []));

describe('http handler events', () => {
  it('emits starting then completed/ok for a route, named as the manifest names it', async () => {
    const events: DotLifecycleEvent[] = [];
    const { app, call } = await boot(events);
    const pinged = await call('/ping');
    expect(pinged.status).toBe(200);
    const seen = handlerEvents(events);
    expect(seen.map(event => [event.transport, event.feature, event.name, event.status])).toEqual([
      ['http', 'shop', 'GET /ping', 'starting'],
      ['http', 'shop', 'GET /ping', 'completed'],
    ]);
    expect(seen[1]).toMatchObject({ outcome: 'ok' });
    await orThrow(app.dispose());
  });

  it('observes an async handler and still answers', async () => {
    const events: DotLifecycleEvent[] = [];
    const { app, call } = await boot(events);
    const { text } = await call('/slow');
    expect(text).toBe('"later"');
    expect(handlerEvents(events).map(event => event.status)).toEqual(['starting', 'completed']);
    await orThrow(app.dispose());
  });

  it('reports a handler-returned Failure as refused, with the Failure', async () => {
    const events: DotLifecycleEvent[] = [];
    const { app, call } = await boot(events);
    expect(await statusOf(call('/find'))).toBe(404);
    const done = handlerEvents(events).find(event => event.status === 'completed');
    expect(done).toMatchObject({ name: 'GET /find', outcome: 'refused' });
    expect(isFailure(done?.failure) && done.failure.code).toBe('test.missing');
    await orThrow(app.dispose());
  });

  it('reports a step refusal as refused, with the Failure, and the client still gets its 401', async () => {
    const events: DotLifecycleEvent[] = [];
    const { app, call } = await boot(events);
    expect(await statusOf(call('/mine'))).toBe(401);
    const done = handlerEvents(events).find(event => event.status === 'completed');
    expect(done).toMatchObject({ name: 'GET /mine', outcome: 'refused' });
    expect(isFailure(done?.failure) && done.failure.code).toBe('test.sign_in');
    expect(await statusOf(call('/mine', { authorization: 'x' }))).toBe(200);
    expect(
      handlerEvents(events)
        .filter(event => event.status === 'completed')
        .map(event => event.outcome),
    ).toEqual(['refused', 'ok']);
    await orThrow(app.dispose());
  });

  it('reports a throw as failed while the client gets the 500 envelope', async () => {
    const events: DotLifecycleEvent[] = [];
    const { app, call } = await boot(events);
    expect(await statusOf(call('/boom'))).toBe(500);
    const failed = handlerEvents(events).find(event => event.status === 'failed');
    expect(failed).toMatchObject({ name: 'GET /boom' });
    expect(failed?.error).toEqual(new Error('kaput'));
    await orThrow(app.dispose());
  });

  it('emits for an rpc mount, and reports a step refusal there', async () => {
    const events: DotLifecycleEvent[] = [];
    const { app, call } = await boot(events);
    const served = await call('/rpc/anything', { authorization: 'x' });
    expect(JSON.parse(served.text)).toEqual({ ok: true });
    expect(handlerEvents(events).map(event => [event.name, event.status])).toEqual([
      ['/rpc', 'starting'],
      ['/rpc', 'completed'],
    ]);
    events.length = 0;
    expect(await statusOf(call('/rpc/anything'))).toBe(401);
    const refused = handlerEvents(events).find(event => event.status === 'completed');
    expect(refused).toMatchObject({ name: '/rpc', outcome: 'refused' });
    expect(isFailure(refused?.failure) && refused.failure.code).toBe('test.sign_in');
    await orThrow(app.dispose());
  });

  it('answers the same with and without an observer', async () => {
    const watched = await boot([]);
    const quiet = await boot();
    for (const path of ['/ping', '/find', '/mine', '/boom', '/slow']) {
      expect(await watched.call(path)).toEqual(await quiet.call(path));
    }
    await orThrow(watched.app.dispose());
    await orThrow(quiet.app.dispose());
  });
});
