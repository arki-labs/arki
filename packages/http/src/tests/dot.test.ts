/**
 * The `http()` plugin inside a real DOT app: token-collected bundles, the
 * socketless fetch seam, manifest registration with schemas, real
 * listening on an ephemeral port, drain-on-stop semantics, and the E005
 * drain-timeout watchdog.
 *
 * These tests run under Node (vitest), so `listen` exercises the
 * `@hono/node-server` path; the Bun path shares everything above the
 * socket layer.
 */

import { defineApp, provide, service, token, plugin } from '@arki/dot/plugin';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { RouteBundle } from '../bundle.js';
import { routes } from '../bundle.js';
import { route } from '../contract.js';
import { http, registerRoutes } from '../dot.js';
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
const OrdersFeature = token<{ readonly routes?: RouteBundle }>()('feature.orders');

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
  boot: () => ({ ordersDb: { list: () => [{ id: 'o1' }] } satisfies OrdersDb }),
});

const ordersPlugin = plugin({
  name: 'orders',
  needs: { ordersDb: service<OrdersDb>() },
  configure(ctx) {
    registerRoutes(ctx, [listOrders, progress]);
  },
  boot: ({ ordersDb }) =>
    provide(
      OrdersRoutes,
      routes()
        .bind(listOrders, () => ordersDb.list())
        .bind(progress, async function* ({ params }) {
          yield { step: Number(params.id === 'o1') };
        }),
    ),
});

describe('http() plugin', () => {
  it('collects bundles, serves via the socketless fetch seam, and registers manifest actions', async () => {
    const app = await defineApp('http-test')
      .use(ordersDbPlugin)
      .use(ordersPlugin)
      .use(http({ port: 0, bundles: [OrdersRoutes] }))
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

  it('collects route bundles from feature tokens without declaring activator actions', async () => {
    const featurePlugin = plugin({
      name: 'orders-feature',
      needs: { ordersDb: service<OrdersDb>() },
      actions: [listOrders],
      boot: ({ ordersDb }) =>
        provide(
          OrdersFeature,
          {
            routes: routes().bind(listOrders, () => ordersDb.list()),
          },
        ),
    });

    const app = await defineApp('http-feature-test')
      .use(ordersDbPlugin)
      .use(featurePlugin)
      .use(http({ port: 0, features: [OrdersFeature] as const }))
      .boot();

    const res = await app.services.httpServer.fetch(new Request('http://in-process/orders'));
    expect(await res.json()).toEqual([{ id: 'o1' }]);
    expect(app.manifest.actions.map(action => `${action.plugin}:${action.id}`)).toEqual(['orders-feature:orders.list']);

    await app.dispose();
  });

  it('start listens on an ephemeral port; stop drains in-flight requests before returning', async () => {
    const gate = deferred();
    const entered = deferred();
    const slow = route.get('/slow', { id: 'slow', output: z.object({ done: z.boolean() }) });
    const SlowRoutes = token<RouteBundle>()('slow.routes');
    const slowPlugin = plugin({
      name: 'slow',
      boot: () =>
        provide(
          SlowRoutes,
          routes().bind(slow, async () => {
            entered.resolve();
            await gate.promise;
            return { done: true };
          }),
        ),
    });

    const app = await defineApp('http-drain')
      .use(slowPlugin)
      .use(http({ port: 0, bundles: [SlowRoutes] }))
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
      boot: () =>
        provide(
          HangRoutes,
          routes().bind(hang, async () => {
            await new Promise<never>(() => {
              // Deliberately never settles — the drain watchdog is the subject.
            });
            return { done: true };
          }),
        ),
    });

    const app = await defineApp('http-hang')
      .use(hangPlugin)
      .use(http({ port: 0, bundles: [HangRoutes], drainTimeoutMs: 100 }))
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
    void defineApp('http-guard').use(http({ port: 0, bundles: [Ghost] }));
  });

  it('enforces feature token provision in the type system', () => {
    const Ghost = token<{ readonly routes?: RouteBundle }>()('ghost.feature');
    // @ts-expect-error — nothing provides ghost.feature, so the wiring guard rejects the composition
    void defineApp('http-feature-guard').use(http({ port: 0, features: [Ghost] as const }));
  });

  it('rejects the same bundle token listed twice', () => {
    try {
      http({ port: 0, bundles: [OrdersRoutes, OrdersRoutes] });
      expect.unreachable('duplicate bundle token must throw');
    } catch (error) {
      expect(error).toMatchObject({ code: HTTP_ERROR_CODES.duplicateRoute });
    }
  });

  it('rejects the same feature token listed twice', () => {
    try {
      http({ port: 0, features: [OrdersFeature, OrdersFeature] as const });
      expect.unreachable('duplicate feature token must throw');
    } catch (error) {
      expect(error).toMatchObject({ code: HTTP_ERROR_CODES.duplicateRoute });
    }
  });
});
