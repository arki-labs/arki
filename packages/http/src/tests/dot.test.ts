/**
 * The `http()` pip inside a real DOT app: token-collected bundles, the
 * socketless fetch seam, manifest registration with schemas, real
 * listening on an ephemeral port, drain-on-stop semantics, and the E005
 * drain-timeout watchdog.
 *
 * These tests run under Node (vitest), so `listen` exercises the
 * `@hono/node-server` path; the Bun path shares everything above the
 * socket layer.
 */

import { defineApp, provide, service, token, pip } from '@arki/dot/pip';
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

type OrdersDb = { list(): { id: string }[] };

const ordersDbPip = pip({
  name: 'orders-db',
  boot: () => ({ ordersDb: { list: () => [{ id: 'o1' }] } satisfies OrdersDb }),
});

const ordersPip = pip({
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

describe('http() pip', () => {
  it('collects bundles, serves via the socketless fetch seam, and registers manifest routes', async () => {
    const app = await defineApp('http-test')
      .use(ordersDbPip)
      .use(ordersPip)
      .use(http({ port: 0, bundles: [OrdersRoutes] }))
      .boot();

    const { httpServer } = app.services;
    // Not started: no socket, but the composed handler works.
    expect(httpServer.port()).toBeUndefined();
    const res = await httpServer.fetch(new Request('http://in-process/orders'));
    expect(await res.json()).toEqual([{ id: 'o1' }]);

    const registered = app.manifest.routes.filter(r => r.pip === 'orders');
    expect(registered.map(r => r.id)).toEqual(['orders.list', 'orders.progress']);
    expect(registered[0]?.output).toMatchObject({ type: 'array' });
    expect(registered[1]?.streaming).toBe(true);
    expect(app.manifest.services.some(s => s.name === 'httpServer' && s.pip === 'http')).toBe(true);

    await app.dispose();
  });

  it('start listens on an ephemeral port; stop drains in-flight requests before returning', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const slow = route.get('/slow', { id: 'slow', output: z.object({ done: z.boolean() }) });
    const SlowRoutes = token<RouteBundle>()('slow.routes');
    const slowPip = pip({
      name: 'slow',
      boot: () =>
        provide(
          SlowRoutes,
          routes().bind(slow, async () => {
            await gate;
            return { done: true };
          }),
        ),
    });

    const app = await defineApp('http-drain')
      .use(slowPip)
      .use(http({ port: 0, bundles: [SlowRoutes] }))
      .start();

    const url = app.services.httpServer.url();
    expect(url).toBeDefined();
    expect(app.services.httpServer.port()).toBeGreaterThan(0);

    const inflight = fetch(`${url!}/slow`);
    // Wait until the request is actually being handled.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(app.services.httpServer.inflight()).toBe(1);

    const stopping = app.stop();
    // Give stop a beat to stop accepting; the in-flight request must still complete.
    await new Promise(resolve => setTimeout(resolve, 50));
    release?.();

    const [res] = await Promise.all([inflight, stopping]);
    expect(await res.json()).toEqual({ done: true });
    expect(app.services.httpServer.inflight()).toBe(0);
    expect(app.services.httpServer.port()).toBeUndefined();

    await app.dispose();
  });

  it('throws the E005 drain watchdog when handlers outlive the budget', async () => {
    const hang = route.get('/hang', { id: 'hang', output: z.object({ done: z.boolean() }) });
    const HangRoutes = token<RouteBundle>()('hang.routes');
    const hangPip = pip({
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
      .use(hangPip)
      .use(http({ port: 0, bundles: [HangRoutes], drainTimeoutMs: 100 }))
      .start();

    const url = app.services.httpServer.url();
    const doomed = fetch(`${url!}/hang`).catch(() => 'severed');
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
    expect(await doomed).toBe('severed');
  });

  it('enforces bundle provision in the type system', () => {
    const Ghost = token<RouteBundle>()('ghost.routes');
    // @ts-expect-error — nothing provides ghost.routes, so the wiring guard rejects the composition
    void defineApp('http-guard').use(http({ port: 0, bundles: [Ghost] }));
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
