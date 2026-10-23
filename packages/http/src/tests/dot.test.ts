/**
 * The `http()` entrypoint inside a real DOT app: routes from the
 * app's mounted features and from token bundles, the socketless fetch seam, manifest registration with schemas, real
 * listening on an ephemeral port, drain-on-stop semantics, and the E005
 * drain-timeout watchdog.
 *
 * These tests run under Node (vitest), so `listen` exercises the
 * `@hono/node-server` path; the Bun path shares everything above the
 * socket layer.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { DepsOf } from '@arki/dot/feature';
import { defineFeature, entrypointOnly } from '@arki/dot/feature';
import { defineApp, DotLifecycleErrorCode, infra, rename, service, token } from '@arki/dot/unit';
import { orThrow, UnexpectedDefect } from '@arki/failure';

import type { RouteBundle } from '../bundle.js';
import { routes, rpcMount } from '../bundle.js';
import { route } from '../contract.js';
import { endpoints as coreEndpoints, http, HTTP_PLUGIN_ERROR_CODES, registerRoutes } from '../dot.js';
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

const ordersDbPlugin = infra({
  name: 'orders-db',
  provides: { ordersDb: () => ({ list: () => [{ id: 'o1' }] }) satisfies OrdersDb },
});

const ordersPlugin = infra({
  name: 'orders',
  needs: { ordersDb: service<OrdersDb>() },
  configure(ctx) {
    registerRoutes(ctx, [listOrders, progress]);
  },
  provides: {
    [OrdersRoutes.key]: ({ ordersDb }) =>
      routes()
        .bind(listOrders, () => ordersDb.list())
        .bind(progress, async function* ({ params }) {
          yield { step: Number(params.id === 'o1') };
        }),
  },
});

describe('http() plugin', () => {
  it('collects bundles, serves via the socketless fetch seam, and registers manifest actions', async () => {
    const app = await orThrow(
      defineApp('http-test')
        .infra(ordersDbPlugin)
        .infra(ordersPlugin)
        .entrypoints(http({ port: 0, bundles: [OrdersRoutes] }))
        .boot(),
    );

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

    await orThrow(app.dispose());
  });

  // The point of an entrypoint: the app lists its features once, in
  // `.features()`, and `.entrypoints(http())` serves their routes. A second list
  // inside http() would drift from the first.
  it('serves the routes of every mounted feature without the app listing them again', async () => {
    const ordersCore = defineFeature('orders')
      .needs({ ordersDb: service<OrdersDb>() })
      .usecases({ list: ({ ordersDb }) => () => ordersDb.list() });
    const orders = ordersCore.entrypoints(
      coreEndpoints(ordersCore, ({ usecases }) => routes().bind(listOrders, () => orThrow(usecases.list())), {
        contracts: [listOrders],
      }),
    );
    // A feature with no HTTP surface is skipped, not an error.
    const quiet = defineFeature('quiet').entrypoints();

    const app = await orThrow(
      defineApp('http-feature-test')
        .infra(ordersDbPlugin)
        .features([orders, quiet])
        .entrypoints(http({ port: 0 }))
        .boot(),
    );

    const res = await app.services.httpServer.fetch(new Request('http://in-process/orders'));
    expect(await res.json()).toEqual([{ id: 'o1' }]);
    // Route contracts belong to the feature; the entrypoint declares none of its own.
    expect(app.manifest.actions.map(action => `${action.plugin}:${action.id}`)).toEqual(['orders:orders.list']);

    await orThrow(app.dispose());
  });

  // Why: an `entrypointOnly` need exists for what only a driving adapter holds (a health
  // probe's db handle, a transaction middleware's db). `endpoints()` is a driving adapter,
  // so its build must receive that need, typed, even on a feature with no usecases at all.
  it('hands endpoints(core, build) the feature\'s entrypointOnly needs, before .usecases() too', async () => {
    const probeCore = defineFeature('probe').needs({ ordersDb: entrypointOnly(ordersDbPlugin.provides.ordersDb) });
    const probe = probeCore.entrypoints(
      coreEndpoints(probeCore, ({ ordersDb }) => routes().bind(listOrders, () => ordersDb.list()), {
        contracts: [listOrders],
      }),
    );

    const app = await orThrow(
      defineApp('http-entrypoint-only-test')
        .infra(ordersDbPlugin)
        .features([probe])
        .entrypoints(http({ port: 0 }))
        .boot(),
    );

    const res = await app.services.httpServer.fetch(new Request('http://in-process/orders'));
    expect(await res.json()).toEqual([{ id: 'o1' }]);

    await orThrow(app.dispose());
  });

  it("serves a defineFeature feature's endpoints(core, build) next to a feature without private infra", async () => {
    // Why: an app mounts several features behind one route table, and a
    // handler reaches private infra through usecases.
    const store = infra({
      name: 'store',
      needs: { ordersDb: service<OrdersDb>() },
      provides: { store: ({ ordersDb }) => ({ all: () => ordersDb.list() }) },
    });
    // The store needs `ordersDb` unbound; the feature names the handle once, in `.needs()`.
    const base = defineFeature('orders').needs({ ordersDb: ordersDbPlugin.provides.ordersDb }).infra(store);
    const core = base.usecases({
      list:
        ({ store }: DepsOf<typeof base>) =>
        () =>
          store.all(),
    });
    const orderRoutes = (c: typeof core) =>
      coreEndpoints(c, ({ usecases }) => routes().bind(listOrders, () => orThrow(usecases.list())), {
        contracts: [listOrders],
      });
    const orders = core.entrypoints(orderRoutes(core));
    const statusCore = defineFeature('status').usecases({});
    const status = statusCore.entrypoints(
      coreEndpoints(statusCore, () => routes().bind(health, () => ({ ok: true })), { contracts: [health] }),
    );

    const app = await orThrow(
      defineApp('http-mixed')
        .infra(ordersDbPlugin)
        .features([orders, status])
        .entrypoints(http({ port: 0 }))
        .boot(),
    );

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
    await orThrow(app.dispose());
  });

  it('types endpoints(core, build) services from the core', () => {
    const core = defineFeature('typed').usecases({ ping: () => () => 'pong' });
    coreEndpoints(core, ({ usecases }) => routes().bind(health, () => ({ ok: usecases.ping() === 'pong' })));
    // @ts-expect-error -- `ordersDb` is not a need, infra service or usecases of this feature
    coreEndpoints(core, ({ ordersDb }) => routes().bind(listOrders, () => ordersDb.list()));
    expect(true).toBe(true);
  });

  // Why http() belongs in `.entrypoints()`: under `.infra()` it would boot before
  // the features, when their routes do not exist yet. The builder rejects
  // it at compile time, so an app never serves a silently empty route table.
  it('cannot be mounted with .infra() ahead of the features it serves', () => {
    const ordersCore = defineFeature('orders').usecases({});
    const orders = ordersCore.entrypoints(
      coreEndpoints(ordersCore, () => routes().bind(listOrders, () => []), { contracts: [listOrders] }),
    );

    const tooEarly = () =>
      defineApp('http-too-early')
        // @ts-expect-error — http() is an entrypoint: it belongs in .entrypoints(), after .features()
        .infra(http({ port: 0 }))
        .features([orders]);
    expect(tooEarly).toBeTypeOf('function');
  });

  it('serves token bundles and feature routes from one route table', async () => {
    const statusCore = defineFeature('status').usecases({});
    const status = statusCore.entrypoints(
      coreEndpoints(statusCore, () => routes().bind(health, () => ({ ok: true })), { contracts: [health] }),
    );

    const app = await orThrow(
      defineApp('http-mixed-test')
        .infra(ordersDbPlugin)
        .infra(ordersPlugin)
        .features([status])
        .entrypoints(http({ port: 0, bundles: [OrdersRoutes] }))
        .boot(),
    );

    const { httpServer } = app.services;
    const ordersRes = await httpServer.fetch(new Request('http://in-process/orders'));
    expect(await ordersRes.json()).toEqual([{ id: 'o1' }]);
    const healthRes = await httpServer.fetch(new Request('http://in-process/health'));
    expect(await healthRes.json()).toEqual({ ok: true });

    await orThrow(app.dispose());
  });

  it('fails boot with E010 when a feature publishes a routes slice that is not a bundle', async () => {
    const broken = defineFeature('broken').entrypoints({
      kind: 'routes',
      key: 'routes',
      actions: [],
      resolve: () => ({ not: 'a bundle' }),
    });

    await expect(
      defineApp('http-broken-slice')
        .features([broken])
        .entrypoints(http({ port: 0 }))
        .boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: { code: HTTP_PLUGIN_ERROR_CODES.routesSliceInvalid },
    });
  });

  it('start listens on an ephemeral port; stop drains in-flight requests before returning', async () => {
    const gate = deferred();
    const entered = deferred();
    const slow = route.get('/slow', { id: 'slow', output: z.object({ done: z.boolean() }) });
    const SlowRoutes = token<RouteBundle>()('slow.routes');
    const slowPlugin = infra({
      name: 'slow',
      provides: {
        [SlowRoutes.key]: () =>
          routes().bind(slow, async () => {
            entered.resolve();
            await gate.promise;
            return { done: true };
          }),
      },
    });

    const app = await orThrow(
      defineApp('http-drain')
        .infra(slowPlugin)
        .entrypoints(http({ port: 0, bundles: [SlowRoutes] }))
        .start(),
    );

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

    await orThrow(app.dispose());
  });

  it('returns the E005 drain watchdog when handlers outlive the budget', async () => {
    const hang = route.get('/hang', { id: 'hang', output: z.object({ done: z.boolean() }) });
    const HangRoutes = token<RouteBundle>()('hang.routes');
    const hangPlugin = infra({
      name: 'hang',
      provides: {
        [HangRoutes.key]: () =>
          routes().bind(hang, async () => {
            await new Promise<never>(() => {
              // Deliberately never settles — the drain watchdog is the subject.
            });
            return { done: true };
          }),
      },
    });

    const app = await orThrow(
      defineApp('http-hang')
        .infra(hangPlugin)
        .entrypoints(http({ port: 0, bundles: [HangRoutes], drainTimeoutMs: 100 }))
        .start(),
    );

    const url = app.services.httpServer.url();
    const controller = new AbortController();
    const doomed = fetch(`${url!}/hang`, { signal: controller.signal }).catch(() => 'severed');
    await new Promise(resolve => setTimeout(resolve, 50));

    const failure = await app.stop();
    expect(UnexpectedDefect.is(failure)).toBe(true);
    if (!UnexpectedDefect.is(failure)) throw new Error('Expected the drain watchdog defect');
    expect(failure.cause).toMatchObject({
      code: DotLifecycleErrorCode.StopFailed,
      phase: 'stop',
      plugin: 'http',
      cause: {
        code: HTTP_ERROR_CODES.drainTimeout,
        message: expect.stringMatching(/1 request\(s\) still in flight after the 100ms drain budget/),
      },
    });
    controller.abort();
    expect(await doomed).toBe('severed');
  });

  it('enforces bundle provision in the type system', () => {
    const Ghost = token<RouteBundle>()('ghost.routes');
    // @ts-expect-error — nothing provides ghost.routes, so the wiring guard rejects the composition
    void defineApp('http-guard').entrypoints(http({ port: 0, bundles: [Ghost] }));
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

describe('http() with feature instances', () => {
  // Why: a route contract is written once in the feature, so two copies of one
  // feature would claim the same `GET /reports`. Each copy is served under its
  // instance name instead, and each copy answers from its own database.
  const regionDb = (region: string) => infra({ name: 'database', provides: { db: () => ({ region }) } });
  const database = regionDb('us');
  const databaseEu = rename(regionDb('eu'), { db: 'dbEu' }, 'databaseEu');
  const listReports = route.get('/reports', { id: 'reports.list', output: z.object({ region: z.string() }) });
  const reportsHome = route.get('/', { id: 'reports.home', output: z.object({ region: z.string() }) });

  const reportsCore = defineFeature('reports')
    .needs({ db: database.provides.db })
    .usecases({
      region:
        ({ db }) =>
        () =>
          db.region,
    });
  const reports = reportsCore.entrypoints(
    coreEndpoints(
      reportsCore,
      ({ usecases }) =>
        routes()
          .bind(listReports, () => ({ region: orThrow(usecases.region()) }))
          .bind(reportsHome, () => ({ region: orThrow(usecases.region()) })),
      { contracts: [listReports, reportsHome] },
    ),
  );

  const get = async (
    app: { readonly services: { readonly httpServer: { fetch(req: Request): Promise<Response> } } },
    path: string,
  ) => app.services.httpServer.fetch(new Request(`http://in-process${path}`));

  it('serves each instance under /<instance>, each on its own rebound need', async () => {
    const app = await orThrow(
      defineApp('http-instances')
        .infra(database)
        .infra(databaseEu)
        .features([reports.instance('eu', { db: databaseEu.provides.dbEu }), reports.instance('us')])
        .entrypoints(http({ port: 0 }))
        .boot(),
    );
    expect(await (await get(app, '/eu/reports')).json()).toEqual({ region: 'eu' });
    expect(await (await get(app, '/us/reports')).json()).toEqual({ region: 'us' });
    expect(await (await get(app, '/eu')).json()).toEqual({ region: 'eu' });
    expect((await get(app, '/reports')).status).toBe(404);
    await orThrow(app.dispose());
  });

  it('honours a custom instancePath', async () => {
    const app = await orThrow(
      defineApp('http-instances-custom')
        .infra(database)
        .infra(databaseEu)
        .features([reports.instance('eu', { db: databaseEu.provides.dbEu }), reports.instance('us')])
        .entrypoints(http({ port: 0, instancePath: (instance, path) => `/v1${path}.${instance}` }))
        .boot(),
    );
    expect(await (await get(app, '/v1/reports.eu')).json()).toEqual({ region: 'eu' });
    expect(await (await get(app, '/v1/reports.us')).json()).toEqual({ region: 'us' });
    await orThrow(app.dispose());
  });

  it('leaves a plain feature unprefixed, and still refuses the same plain feature twice', async () => {
    const plain = await orThrow(
      defineApp('http-plain')
        .infra(database)
        .features([reports])
        .entrypoints(http({ port: 0 }))
        .boot(),
    );
    expect(await (await get(plain, '/reports')).json()).toEqual({ region: 'us' });
    await plain.dispose();

    const other = defineFeature('reports-two').entrypoints(
      coreEndpoints(defineFeature('reports-two'), () => routes().bind(listReports, () => ({ region: 'x' })), {
        contracts: [listReports],
      }),
    );
    // Boot wraps the engine's refusal in its lifecycle error; the cause keeps the code.
    await expect(
      defineApp('http-collide')
        .infra(database)
        .features([reports, other])
        .entrypoints(http({ port: 0 }))
        .boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: expect.objectContaining({ message: expect.stringMatching(/duplicate route GET \/reports/) }),
    });
  });

  it('serves an instance rpc mount under /<instance> and hands the handler the un-prefixed URL', async () => {
    // Why: an oRPC/tRPC handler matches the prefix written in the feature, so it
    // must never see the instance segment, or the copy would answer 404.
    const gatewayRpc = rpcMount('/rpc', { id: 'gateway.rpc' });
    const gatewayCore = defineFeature('gateway');
    const gateway = gatewayCore.entrypoints(
      coreEndpoints(gatewayCore, () =>
        routes().rpc(gatewayRpc, {
          context: () => ({}),
          handle: req => Response.json({ path: new URL(req.url).pathname }),
        }),
      ),
    );
    const app = await orThrow(
      defineApp('http-instances-rpc')
        .features([gateway.instance('eu')])
        .entrypoints(http({ port: 0 }))
        .boot(),
    );
    expect(await (await get(app, '/eu/rpc/orders.list')).json()).toEqual({ path: '/rpc/orders.list' });
    expect((await get(app, '/rpc/orders.list')).status).toBe(404);
    await orThrow(app.dispose());
  });
});
