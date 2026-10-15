/**
 * The `http()` driving adapter inside a real DOT app: routes from the
 * app's mounted features and from token bundles, the socketless fetch seam, manifest registration with schemas, real
 * listening on an ephemeral port, drain-on-stop semantics, and the E005
 * drain-timeout watchdog.
 *
 * These tests run under Node (vitest), so `listen` exercises the
 * `@hono/node-server` path; the Bun path shares everything above the
 * socket layer.
 */

import type { DepsOf } from '@arki/dot/feature';
import { defineFeature, feature } from '@arki/dot/feature';
import { defineApp, service, token, plugin } from '@arki/dot/plugin';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { RouteBundle } from '../bundle.js';
import { endpoints, routes } from '../bundle.js';
import { route } from '../contract.js';
import { endpoints as coreEndpoints, HTTP_PLUGIN_ERROR_CODES, http, registerRoutes } from '../dot.js';
import { HTTP_ERROR_CODES } from '../error.js';

const listOrders = route.get('/orders', {
  id: 'orders.list',
  output: z.array(z.object({ id: z.string() })),
});

const progress = route.sse('/orders/:id/progress', {
  id: 'orders.progress',
  event: z.object({ step: z.number() }),
});

const OrdersRoutes = token<RouteBundle>()('orders.routes');
const health = route.get('/health', {
  id: 'health.get',
  output: z.object({ ok: z.boolean() }),
});

type OrdersDb = { list(): { id: string }[] };

function resolveBeforeDeferredInitialization(): never {
  throw new Error('deferred promise resolved before initialization');
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: () => void = resolveBeforeDeferredInitialization;
  const promise = new Promise<void>(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

const ordersDbPlugin = plugin({
  name: 'orders-db',
  provides: { ordersDb: () => ({ list: () => [{ id: 'o1' }] }) satisfies OrdersDb },
});

const ordersPlugin = plugin({
  name: 'orders',
  needs: { ordersDb: service<OrdersDb>() },
  configure(ctx) {
    registerRoutes(ctx, [listOrders, progress]);
  },
  provides: { [OrdersRoutes.key]: ({ ordersDb }) =>
    routes()
        .bind(listOrders, () => ordersDb.list())
        .bind(progress, async function* ({ params }) {
          yield { step: Number(params.id === 'o1') };
        }) },
});

describe('http() plugin', () => {
  it('collects bundles, serves via the socketless fetch seam, and registers manifest actions', async () => {
    const app = await defineApp('http-test')
      .use(ordersDbPlugin)
      .use(ordersPlugin)
      .serve(http({ port: 0, bundles: [OrdersRoutes] }))
      .boot();

    const { httpServer } = app.services;
    // Not started: no socket, but the composed handler works.
    expect(httpServer.port()).toBeUndefined();
    const res = await httpServer.fetch(new Request('http://in-process/orders'));
    expect(await res.json()).toEqual([{ id: 'o1' }]);

    const registered = app.manifest.actions.filter(action => action.plugin === 'orders');
    expect(registered.map(action => action.id)).toEqual(['orders.list', 'orders.progress']);
    expect(registered[0]?.meta?.['output']).toMatchObject({ type: 'array' });
    expect(registered[1]?.meta?.['streaming']).toBe(true);
    expect(app.manifest.services.some(s => s.name === 'httpServer' && s.plugin === 'http')).toBe(true);
    expect(app.manifest.projections).toContainEqual({
      format: 'openapi',
      binding: 'http',
      module: '@arki/http/projection',
      plugin: 'http',
    });

    await app.dispose();
  });

  // The point of a driver: the app lists its features once, in
  // `.features()`, and `.serve(http())` serves their routes. A second list
  // inside http() would drift from the first.
  it('serves the routes of every mounted feature without the app listing them again', async () => {
    const orders = feature('orders', {
      needs: { ordersDb: service<OrdersDb>() },
      actions: [listOrders],
      use: [endpoints(({ ordersDb }: { readonly ordersDb: OrdersDb }) => routes().bind(listOrders, () => ordersDb.list()))],
    });
    // A feature with no HTTP surface is skipped, not an error.
    const quiet = feature('quiet', {});

    const app = await defineApp('http-feature-test')
      .use(ordersDbPlugin)
      .features([orders, quiet])
      .serve(http({ port: 0 }))
      .boot();

    const res = await app.services.httpServer.fetch(new Request('http://in-process/orders'));
    expect(await res.json()).toEqual([{ id: 'o1' }]);
    // Route contracts belong to the feature; the driver declares none of its own.
    expect(app.manifest.actions.map(action => `${action.plugin}:${action.id}`)).toEqual(['orders:orders.list']);

    await app.dispose();
  });

  it("serves a defineFeature feature's endpoints(core, build) next to an object-form feature", async () => {
    // Why: during the migration an app mounts both forms behind one route
    // table, and the chain form's handlers reach private infra through usecases.
    const store = plugin({
      name: 'store',
      needs: { ordersDb: service<OrdersDb>() },
      provides: { store: ({ ordersDb }) => ({ all: () => ordersDb.list() }) },
    });
    const base = defineFeature('orders').infra(store);
    const core = base.usecases({ list: ({ store }: DepsOf<typeof base>) => () => store.all() });
    const orderRoutes = (c: typeof core) =>
      coreEndpoints(c, ({ usecases }) => routes().bind(listOrders, () => usecases.list()), { contracts: [listOrders] });
    const orders = core.entrypoints(orderRoutes(core));
    const status = feature('status', {
      actions: [health],
      use: [endpoints(() => routes().bind(health, () => ({ ok: true })))],
    });

    const app = await defineApp('http-mixed')
      .infra(ordersDbPlugin)
      .features([orders, status])
      .entrypoints(http({ port: 0 }))
      .boot();

    const { httpServer } = app.services;
    const ordersRes = await httpServer.fetch(new Request('http://in-process/orders'));
    const healthRes = await httpServer.fetch(new Request('http://in-process/health'));
    expect(await ordersRes.json()).toEqual([{ id: 'o1' }]);
    expect(await healthRes.json()).toEqual({ ok: true });
    // The chain feature's route contracts are its actions, known before boot.
    expect(app.manifest.actions.map(action => `${action.plugin}:${action.id}`)).toEqual([
      'orders:orders.list',
      'status:health.get',
    ]);
    await app.dispose();
  });

  it('types endpoints(core, build) services from the core', () => {
    const core = defineFeature('typed').usecases({ ping: () => () => 'pong' });
    coreEndpoints(core, ({ usecases }) => routes().bind(health, () => ({ ok: usecases.ping() === 'pong' })));
    // @ts-expect-error -- `ordersDb` is not a need, infra service or usecases of this feature
    coreEndpoints(core, ({ ordersDb }) => routes().bind(listOrders, () => ordersDb.list()));
    expect(true).toBe(true);
  });

  // Why http() belongs in `.serve()`: under `.use()` it would boot before
  // the features, when their routes do not exist yet. The builder rejects
  // it at compile time, so an app never serves a silently empty route table.
  it('cannot be mounted with .use() ahead of the features it serves', () => {
    const orders = feature('orders', {
      actions: [listOrders],
      use: [endpoints(() => routes().bind(listOrders, () => []))],
    });

    // @ts-expect-error — http() is a driving adapter: it belongs in .serve(), after .features()
    const tooEarly = () => defineApp('http-too-early').use(http({ port: 0 })).features([orders]);
    expect(tooEarly).toBeTypeOf('function');
  });

  it('serves token bundles and feature routes from one route table', async () => {
    const status = feature('status', {
      actions: [health],
      use: [endpoints(() => routes().bind(health, () => ({ ok: true })))],
    });

    const app = await defineApp('http-mixed-test')
      .use(ordersDbPlugin)
      .use(ordersPlugin)
      .features([status])
      .serve(http({ port: 0, bundles: [OrdersRoutes] }))
      .boot();

    const { httpServer } = app.services;
    const ordersRes = await httpServer.fetch(new Request('http://in-process/orders'));
    expect(await ordersRes.json()).toEqual([{ id: 'o1' }]);
    const healthRes = await httpServer.fetch(new Request('http://in-process/health'));
    expect(await healthRes.json()).toEqual({ ok: true });

    await app.dispose();
  });

  it('fails boot with E010 when a feature publishes a routes slice that is not a bundle', async () => {
    const broken = feature('broken', {
      use: [{ key: 'routes', actions: [], resolve: () => ({ not: 'a bundle' }) }],
    });

    await expect(defineApp('http-broken-slice').features([broken]).serve(http({ port: 0 })).boot()).rejects.toMatchObject({
      cause: { code: HTTP_PLUGIN_ERROR_CODES.routesSliceInvalid },
    });
  });

  it('start listens on an ephemeral port; stop drains in-flight requests before returning', async () => {
    const gate = deferred();
    const entered = deferred();
    const slow = route.get('/slow', { id: 'slow', output: z.object({ done: z.boolean() }) });
    const SlowRoutes = token<RouteBundle>()('slow.routes');
    const slowPlugin = plugin({
      name: 'slow',
      provides: { [SlowRoutes.key]: () =>
        routes().bind(slow, async () => {
            entered.resolve();
            await gate.promise;
            return { done: true };
          }) },
    });

    const app = await defineApp('http-drain')
      .use(slowPlugin)
      .serve(http({ port: 0, bundles: [SlowRoutes] }))
      .start();

    const url = app.services.httpServer.url();
    expect(url).toBeDefined();
    expect(app.services.httpServer.port()).toBeGreaterThan(0);

    const inflight = fetch(`${url!}/slow`);
    // Wait until the request is actually being handled.
    await entered.promise;
    expect(app.services.httpServer.inflight()).toBe(1);

    const stopping = app.stop();
    // Give stop a beat to stop accepting; the in-flight request must still complete.
    await new Promise(resolve => setTimeout(resolve, 50));
    gate.resolve();

    const [res] = await Promise.all([inflight, stopping]);
    expect(await res.json()).toEqual({ done: true });
    expect(app.services.httpServer.inflight()).toBe(0);
    expect(app.services.httpServer.port()).toBeUndefined();

    await app.dispose();
  });

  it('throws the E005 drain watchdog when handlers outlive the budget', async () => {
    const hang = route.get('/hang', { id: 'hang', output: z.object({ done: z.boolean() }) });
    const HangRoutes = token<RouteBundle>()('hang.routes');
    const hangPlugin = plugin({
      name: 'hang',
      provides: { [HangRoutes.key]: () =>
        routes().bind(hang, async () => {
            await new Promise<never>(() => {
              // Deliberately never settles — the drain watchdog is the subject.
            });
            return { done: true };
          }) },
    });

    const app = await defineApp('http-hang')
      .use(hangPlugin)
      .serve(http({ port: 0, bundles: [HangRoutes], drainTimeoutMs: 100 }))
      .start();

    const url = app.services.httpServer.url();
    const controller = new AbortController();
    const doomed = fetch(`${url!}/hang`, { signal: controller.signal }).catch(() => 'severed');
    await new Promise(resolve => setTimeout(resolve, 50));

    let caught: unknown;
    try {
      await app.stop();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const failures = (caught as { failures?: { error: { code?: string } }[] }).failures ?? [];
    expect(failures.some(f => f.error.code === HTTP_ERROR_CODES.drainTimeout)).toBe(true);
    controller.abort();
    expect(await doomed).toBe('severed');
  });

  it('enforces bundle provision in the type system', () => {
    const Ghost = token<RouteBundle>()('ghost.routes');
    // @ts-expect-error — nothing provides ghost.routes, so the wiring guard rejects the composition
    void defineApp('http-guard').serve(http({ port: 0, bundles: [Ghost] }));
  });

  it('rejects the same bundle token listed twice', () => {
    try {
      http({ port: 0, bundles: [OrdersRoutes, OrdersRoutes] });
      expect.unreachable('duplicate bundle token must throw');
    } catch (error) {
      expect(error).toMatchObject({ code: HTTP_ERROR_CODES.duplicateRoute });
    }
  });
});
