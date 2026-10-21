/**
 * Stress test: a large, realistic unit composition.
 *
 * 28 units across 4 layers (infra → connections → domain → workers), wired
 * with every v2 mechanism at once:
 *
 *   - deep needs chains (api ← admin ← reporting ← orders ← cart ← …)
 *   - tokens with free local aliases + a derived `.instance()` token
 *   - TWO rename() multi-instances (second db, second kv)
 *   - THREE lazy services — two initialized on demand, one deliberately
 *     never touched (must never init, never clean up)
 *   - all five hooks, routes in configure, `$config`, observers, timeline
 *
 * Assertions pin the exact boot order (= declaration order), start order,
 * reverse stop order, and the exact interleaving of dispose hooks with
 * kernel-driven lazy cleanup. The 28-deep `.infra()` chain itself is the
 * type-level proof: this file compiling under strict mode means the
 * builder's accumulated generics survive real-world depth.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import { orThrow } from '@arki/failure';

import type { DotLifecycleEvent } from '../lifecycle-observer.js';
import type { Lazy } from '../unit-contract.js';
import { defineApp } from '../define-app.js';
import { lazy, infra, rename, service, token } from '../unit-contract.js';

/* ------------------------------------------------------------------ */
/* Domain types                                                        */
/* ------------------------------------------------------------------ */

type Env = { readonly region: string; readonly mailFrom: string };
type Clock = { now(): number };
type Log = { info(m: string): void; readonly lines: string[] };
type Metrics = { incr(k: string): void; readonly counts: Record<string, number> };
type Db = { readonly instance: string; query(sql: string): Promise<string> };
type KvClient = { readonly ns: string; set(k: string, v: string): void; readonly store: Map<string, string> };
type SearchClient = { index(doc: string): void; readonly docs: string[] };
type BlobStore = { put(key: string): void };
type Mailer = { send(to: string): void; readonly sent: string[] };
type Bus = {
  publish(topic: string): void;
  subscribe(topic: string, fn: () => void): void;
  readonly published: string[];
};
type Auth = { verify(t: string): boolean };
type Catalog = { addProduct(id: string): Promise<void>; readonly products: string[] };
type Pricing = { priceOf(id: string): number };
type Inventory = { reserve(id: string): boolean };
type Cart = { add(id: string): void; readonly items: string[] };
type Payments = { charge(amount: number): Promise<string> };
type Orders = { place(): Promise<string>; readonly placed: string[] };
type Shipping = { ship(orderId: string): Promise<void> };
type Notifications = { welcome(user: string): Promise<void> };
type Analytics = { readonly seen: string[] };
type Reporting = { dailyReport(): Promise<string> };
type Admin = { stats(): Promise<string> };
type Api = { handle(path: string): Promise<string> };

/* ------------------------------------------------------------------ */
/* Shared contracts (token layer)                                      */
/* ------------------------------------------------------------------ */

const Kv = token<KvClient>()('stress.kv');
const SessionsKv = Kv.instance('sessions'); // wire key 'stress.kv#sessions'

/* ------------------------------------------------------------------ */
/* Event log + tiny fakes                                              */
/* ------------------------------------------------------------------ */

const events: string[] = [];
const ev = (tag: string) => {
  events.push(tag);
  // eslint-disable-next-line unicorn/no-useless-undefined -- Explicit undefined prevents void from erasing returned failures.
  return undefined;
};

const mkDb = (instance: string): Db => ({ instance, query: async sql => `${instance}:${sql}` });
const mkKv = (ns: string): KvClient => ({
  ns,
  store: new Map(),
  set(k, v) {
    this.store.set(k, v);
  },
});

/* ------------------------------------------------------------------ */
/* Layer 0 — infra                                                     */
/* ------------------------------------------------------------------ */

const envUnit = infra({
  name: 'env',
  provides: {
    env: ({ $config }): Env => {
      ev('boot:env');
      expect($config['FEATURE_STRESS']).toBe(true); // $config threading
      return { region: 'eu-central', mailFrom: 'noreply@stress.test' };
    },
  },
});

const clockUnit = infra({
  name: 'clock',
  provides: {
    clock: (): Clock => {
      ev('boot:clock');
      return { now: () => 1_700_000_000 };
    },
  },
});

const loggerUnit = infra({
  name: 'logger',
  needs: { env: service<Env>() },
  provides: {
    log: ({ env }): Log => {
      ev('boot:logger');
      const lines: string[] = [];
      return { lines, info: m => void lines.push(`[${env.region}] ${m}`) };
    },
  },
});

const metricsUnit = infra({
  name: 'metrics',
  needs: { env: service<Env>(), clock: service<Clock>() },
  provides: {
    metrics: ({ clock }): Metrics => {
      ev('boot:metrics');
      void clock.now();
      const counts: Record<string, number> = {};
      return { counts, incr: k => void (counts[k] = (counts[k] ?? 0) + 1) };
    },
  },
});

/* ------------------------------------------------------------------ */
/* Layer 1 — connections (renames, tokens, lazies)                     */
/* ------------------------------------------------------------------ */

const dbUnitFactory = (instance: string) =>
  infra({
    name: 'db',
    needs: { log: service<Log>() },
    provides: {
      db: ({ log, $unit }) => {
        ev(`boot:${$unit}`);
        log.info(`db ${instance} opening`);
        return mkDb(instance);
      },
    },
    dispose: ({ $unit }) => {
      ev(`dispose:${$unit}`);
    },
  });

const dbUnit = dbUnitFactory('primary');
const reportsDbUnit = rename(dbUnitFactory('reports'), { db: 'reportsDb' }, 'db-reports');

const kvUnitFactory = (ns: string) =>
  infra({
    name: 'kv',
    provides: {
      [Kv.key]: ({ $unit }) => {
        ev(`boot:${$unit}`);
        return mkKv(ns);
      },
    },
    dispose: ({ $unit }) => {
      ev(`dispose:${$unit}`);
    },
  });

const kvUnit = kvUnitFactory('main');
// Rename the token's wire key to the DERIVED token's key — rename and
// token.instance() composing is the multi-instance story for contracts.
const sessionsKvUnit = rename(kvUnitFactory('sessions'), { 'stress.kv': SessionsKv.key }, 'kv-sessions');

const blobUnit = infra({
  name: 'blob',
  provides: {
    blob: () => {
      ev('boot:blob');
      return lazy(
        (): BlobStore => {
          ev('lazyinit:blob'); // must NEVER appear — nobody touches blob
          return { put: () => void 1 };
        },
        { dispose: () => ev('lazyclean:blob') },
      );
    },
  },
});

const searchUnit = infra({
  name: 'search',
  provides: {
    search: () => {
      ev('boot:search');
      return lazy(
        (): SearchClient => {
          ev('lazyinit:search');
          const docs: string[] = [];
          return { docs, index: d => void docs.push(d) };
        },
        { dispose: () => ev('lazyclean:search') },
      );
    },
  },
});

const mailerUnit = infra({
  name: 'mailer',
  needs: { env: service<Env>() },
  provides: {
    mailer: ({ env }) => {
      ev('boot:mailer');
      return lazy(
        (): Mailer => {
          ev('lazyinit:mailer');
          const sent: string[] = [];
          return { sent, send: to => void sent.push(`${env.mailFrom} -> ${to}`) };
        },
        { dispose: () => ev('lazyclean:mailer') },
      );
    },
  },
});

const busUnit = infra({
  name: 'bus',
  provides: {
    bus: () => {
      ev('boot:bus');
      const published: string[] = [];
      const subs = new Map<string, (() => void)[]>();
      const bus: Bus = {
        published,
        publish(topic) {
          published.push(topic);
          for (const fn of subs.get(topic) ?? []) fn();
        },
        subscribe(topic, fn) {
          subs.set(topic, [...(subs.get(topic) ?? []), fn]);
        },
      };
      return bus;
    },
  },
  start: () => ev('start:bus'),
  stop: () => ev('stop:bus'),
  dispose: () => ev('dispose:bus'),
});

/* ------------------------------------------------------------------ */
/* Layer 2 — domain                                                    */
/* ------------------------------------------------------------------ */

const authUnit = infra({
  name: 'auth',
  needs: { db: service<Db>(), cache: Kv, log: service<Log>() }, // token under a free alias
  provides: {
    auth: ({ db, cache, log }): Auth => {
      ev('boot:auth');
      cache.set('auth:ready', '1');
      log.info(`auth against ${db.instance}`);
      return { verify: t => t.startsWith('ok-') };
    },
  },
});

const catalogUnit = infra({
  name: 'catalog',
  needs: { db: service<Db>(), search: service<Lazy<SearchClient>>(), log: service<Log>() },
  provides: {
    catalog: ({ db, search }) => {
      ev('boot:catalog');
      const products: string[] = [];
      const catalog: Catalog = {
        products,
        async addProduct(id) {
          await db.query(`insert ${id}`);
          products.push(id);
          const index = orThrow(await search.get()); // initializes search on first product
          index.index(id);
        },
      };
      return catalog;
    },
  },
});

const pricingUnit = infra({
  name: 'pricing',
  needs: { catalog: service<Catalog>(), env: service<Env>(), clock: service<Clock>() },
  provides: {
    pricing: ({ catalog }): Pricing => {
      ev('boot:pricing');
      return { priceOf: id => (catalog.products.includes(id) ? 100 : 0) };
    },
  },
});

const inventoryUnit = infra({
  name: 'inventory',
  needs: { db: service<Db>(), stock: Kv, metrics: service<Metrics>() },
  provides: {
    inventory: ({ metrics }): Inventory => {
      ev('boot:inventory');
      return {
        reserve: () => {
          metrics.incr('inventory.reserve');
          return true;
        },
      };
    },
  },
});

const cartUnit = infra({
  name: 'cart',
  // Consumes the DERIVED token — wired to the renamed second kv instance.
  needs: { pricing: service<Pricing>(), inventory: service<Inventory>(), sessions: SessionsKv },
  provides: {
    cart: ({ pricing, inventory, sessions }): Cart => {
      ev('boot:cart');
      expect(sessions.ns).toBe('sessions'); // proves the rename+instance wiring
      const items: string[] = [];
      return {
        items,
        add: id => {
          if (inventory.reserve(id) && pricing.priceOf(id) > 0) items.push(id);
          sessions.set('cart', items.join(','));
        },
      };
    },
  },
});

const paymentsUnit = infra({
  name: 'payments',
  needs: { env: service<Env>(), mailer: service<Lazy<Mailer>>(), bus: service<Bus>() },
  provides: {
    payments: ({ bus }): Payments => {
      ev('boot:payments');
      return {
        charge: async amount => {
          bus.publish('payment.charged');
          return `txn-${amount}`;
        },
      };
    },
  },
});

const ordersUnit = infra({
  name: 'orders',
  needs: { db: service<Db>(), cart: service<Cart>(), payments: service<Payments>(), bus: service<Bus>() },
  provides: {
    orders: ({ cart, payments, bus }): Orders => {
      ev('boot:orders');
      const placed: string[] = [];
      return {
        placed,
        async place() {
          const txn = await payments.charge(cart.items.length * 100);
          placed.push(txn);
          bus.publish('order.placed');
          return txn;
        },
      };
    },
  },
});

const shippingUnit = infra({
  name: 'shipping',
  // Declares the blob need but NEVER calls .get() — blob must stay cold.
  needs: { orders: service<Orders>(), blob: service<Lazy<BlobStore>>(), bus: service<Bus>() },
  provides: {
    shipping: ({ blob, bus }): Shipping => {
      ev('boot:shipping');
      return {
        ship: async orderId => {
          void blob; // deliberately unused: laziness means no init
          bus.publish(`shipped:${orderId}`);
        },
      };
    },
  },
});

const notificationsUnit = infra({
  name: 'notifications',
  needs: { mailer: service<Lazy<Mailer>>(), bus: service<Bus>(), auth: service<Auth>() },
  provides: {
    notifications: ({ mailer }): Notifications => {
      ev('boot:notifications');
      return {
        welcome: async user => {
          const client = orThrow(await mailer.get()); // initializes mailer on first use
          client.send(user);
        },
      };
    },
  },
  start: () => ev('start:notifications'),
  stop: () => ev('stop:notifications'),
});

const analyticsUnit = infra({
  name: 'analytics',
  needs: { reportsDb: service<Db>(), metrics: service<Metrics>(), bus: service<Bus>() },
  provides: {
    analytics: ({ reportsDb, bus }): Analytics => {
      ev('boot:analytics');
      expect(reportsDb.instance).toBe('reports'); // renamed second db instance
      const seen: string[] = [];
      bus.subscribe('order.placed', () => void seen.push('order.placed'));
      return { seen };
    },
  },
  start: () => ev('start:analytics'),
  stop: () => ev('stop:analytics'),
});

const reportingUnit = infra({
  name: 'reporting',
  needs: { reportsDb: service<Db>(), catalog: service<Catalog>(), orders: service<Orders>() },
  provides: {
    reporting: ({ reportsDb, catalog, orders }): Reporting => {
      ev('boot:reporting');
      return {
        dailyReport: async () =>
          `${await reportsDb.query('report')}: ${catalog.products.length} products, ${orders.placed.length} orders`,
      };
    },
  },
});

const adminUnit = infra({
  name: 'admin',
  needs: { auth: service<Auth>(), reporting: service<Reporting>(), log: service<Log>() },
  provides: {
    admin: ({ reporting }): Admin => {
      ev('boot:admin');
      return { stats: () => reporting.dailyReport() };
    },
  },
});

const apiUnit = infra({
  name: 'api',
  needs: {
    auth: service<Auth>(),
    catalog: service<Catalog>(),
    cart: service<Cart>(),
    orders: service<Orders>(),
    admin: service<Admin>(),
  },
  configure: ctx => {
    ctx.registerAction({ id: 'api.checkout', binding: 'http', direction: 'in', address: 'POST /checkout' });
    ctx.registerAction({ id: 'api.admin.stats', binding: 'http', direction: 'in', address: 'GET /admin/stats' });
    ctx.registerService('api', 'custom');
  },
  provides: {
    api: ({ auth, orders, admin }): Api => {
      ev('boot:api');
      return {
        handle: async path => {
          if (!auth.verify('ok-user')) return '403';
          if (path === '/checkout') return orders.place();
          if (path === '/admin/stats') return admin.stats();
          return '404';
        },
      };
    },
  },
});

/* ------------------------------------------------------------------ */
/* Layer 3 — workers                                                   */
/* ------------------------------------------------------------------ */

const indexerUnit = infra({
  name: 'worker-indexer',
  needs: { catalog: service<Catalog>(), search: service<Lazy<SearchClient>>(), bus: service<Bus>() },
  boot: () => {
    ev('boot:worker-indexer');
  },
  start: async ({ search }) => {
    ev('start:worker-indexer');
    // Warms the search connection — second get() elsewhere must reuse it.
    orThrow(await search.get());
  },
  stop: () => ev('stop:worker-indexer'),
});

const emailWorkerUnit = infra({
  name: 'worker-emails',
  needs: { notifications: service<Notifications>(), bus: service<Bus>() },
  boot: () => {
    ev('boot:worker-emails');
  },
  start: async ({ notifications }) => {
    ev('start:worker-emails');
    await notifications.welcome('alice@example.com');
  },
  stop: () => ev('stop:worker-emails'),
});

const healthcheckUnit = infra({
  name: 'healthcheck',
  needs: { api: service<Api>(), db: service<Db>(), metrics: service<Metrics>() },
  boot: () => {
    ev('boot:healthcheck');
  },
  start: async ({ db, metrics }) => {
    ev('start:healthcheck');
    await db.query('select 1');
    metrics.incr('healthcheck.ok');
  },
  stop: () => ev('stop:healthcheck'),
});

/* ------------------------------------------------------------------ */
/* The composition — 28 units, one chain                                */
/* ------------------------------------------------------------------ */

const DECLARATION_ORDER = [
  'env',
  'clock',
  'logger',
  'metrics',
  'db',
  'db-reports',
  'kv',
  'kv-sessions',
  'blob',
  'search',
  'mailer',
  'bus',
  'auth',
  'catalog',
  'pricing',
  'inventory',
  'cart',
  'payments',
  'orders',
  'shipping',
  'notifications',
  'analytics',
  'reporting',
  'admin',
  'api',
  'worker-indexer',
  'worker-emails',
  'healthcheck',
] as const;

function composeStressApp() {
  return defineApp('stress-commerce', { version: '9.9.9', config: { FEATURE_STRESS: true } })
    .infra(envUnit)
    .infra(clockUnit)
    .infra(loggerUnit)
    .infra(metricsUnit)
    .infra(dbUnit)
    .infra(reportsDbUnit)
    .infra(kvUnit)
    .infra(sessionsKvUnit)
    .infra(blobUnit)
    .infra(searchUnit)
    .infra(mailerUnit)
    .infra(busUnit)
    .infra(authUnit)
    .infra(catalogUnit)
    .infra(pricingUnit)
    .infra(inventoryUnit)
    .infra(cartUnit)
    .infra(paymentsUnit)
    .infra(ordersUnit)
    .infra(shippingUnit)
    .infra(notificationsUnit)
    .infra(analyticsUnit)
    .infra(reportingUnit)
    .infra(adminUnit)
    .infra(apiUnit)
    .infra(indexerUnit)
    .infra(emailWorkerUnit)
    .infra(healthcheckUnit);
}

describe('stress: 28-unit commerce composition', () => {
  it('boots, runs, and tears down the full graph with exact ordering', async () => {
    events.length = 0;
    const observed: DotLifecycleEvent[] = [];

    const builder = composeStressApp();
    const app = orThrow(await builder.start());
    app.subscribe(e => observed.push(e));

    /* ---- type-level spot checks across the 28-way intersection ---- */
    expectTypeOf(app.services.db).toEqualTypeOf<Db>();
    expectTypeOf(app.services.reportsDb).toEqualTypeOf<Db>();
    expectTypeOf(app.services['stress.kv']).toEqualTypeOf<KvClient>();
    expectTypeOf(app.services['stress.kv#sessions']).toEqualTypeOf<KvClient>();
    expectTypeOf(app.services.blob).toEqualTypeOf<Lazy<BlobStore>>();
    expectTypeOf(app.services.api).toEqualTypeOf<Api>();

    /* ---- lifecycle ordering ---- */
    expect(app.state).toBe('started');
    const bootOrder = events.filter(e => e.startsWith('boot:')).map(e => e.slice(5));
    expect(bootOrder).toEqual([...DECLARATION_ORDER]);
    expect(events.filter(e => e.startsWith('start:'))).toEqual([
      'start:bus',
      'start:notifications',
      'start:analytics',
      'start:worker-indexer',
      'start:worker-emails',
      'start:healthcheck',
    ]);

    /* ---- lazy states after start ---- */
    // search + mailer were initialized by the workers' start hooks, in the
    // workers' start order (indexer before emails); blob stays cold.
    expect(events.filter(e => e.startsWith('lazyinit:'))).toEqual(['lazyinit:search', 'lazyinit:mailer']);
    expect(app.services.blob.initialized).toBe(false);
    expect(app.services.search.initialized).toBe(true);

    /* ---- exercise the domain end-to-end ---- */
    await app.services.catalog.addProduct('sku-1'); // reuses warmed search (no second init)
    app.services.cart.add('sku-1');
    const txn = await app.services.api.handle('/checkout');
    expect(txn).toBe('txn-100');
    expect(app.services.analytics.seen).toEqual(['order.placed']); // bus fan-out worked
    expect(await app.services.api.handle('/admin/stats')).toBe('reports:report: 1 products, 1 orders');
    const searchState = orThrow(await app.services.search.get());
    expect(searchState.docs).toEqual(['sku-1']);
    const mailerState = orThrow(await app.services.mailer.get());
    expect(mailerState.sent).toEqual(['noreply@stress.test -> alice@example.com']);
    expect(events.filter(e => e.startsWith('lazyinit:'))).toHaveLength(2); // still single-flight

    /* ---- manifest: observed wiring at scale ---- */
    const m = app.manifest;
    expect(m.plugins.map(p => p.name)).toEqual([...DECLARATION_ORDER]);
    expect(m.actions.map(action => action.id)).toEqual(['api.checkout', 'api.admin.stats']);
    expect(m.dependencies).toEqual(
      expect.arrayContaining([
        { from: 'logger', to: 'env', kind: 'requires', key: 'env' },
        { from: 'auth', to: 'kv', kind: 'requires', key: 'stress.kv' },
        { from: 'cart', to: 'kv-sessions', kind: 'requires', key: 'stress.kv#sessions' }, // derived token → renamed unit
        { from: 'analytics', to: 'db-reports', kind: 'requires', key: 'reportsDb' }, // renamed db instance
        { from: 'api', to: 'admin', kind: 'requires', key: 'admin' },
        { from: 'healthcheck', to: 'api', kind: 'requires', key: 'api' },
      ]),
    );
    // Every edge points backward in declaration order (services flow forward).
    for (const edge of m.dependencies) {
      const from = DECLARATION_ORDER.indexOf(edge.from as (typeof DECLARATION_ORDER)[number]);
      const to = DECLARATION_ORDER.indexOf(edge.to as (typeof DECLARATION_ORDER)[number]);
      expect(to, `${edge.from} -> ${edge.to} must point to an earlier unit`).toBeLessThan(from);
    }

    /* ---- diagnostics + timeline ---- */
    expect(app.diagnostics.plugins).toHaveLength(28);
    expect(app.diagnostics.plugins.every(p => p.status === 'ok')).toBe(true);
    expect(app.diagnostics.issues).toEqual([]);
    const timeline = app.timeline();
    expect(timeline).toContain('stress-commerce');
    expect(timeline).toContain('worker-indexer');

    /* ---- teardown: reverse stop, then reverse dispose + lazy cleanup ---- */
    events.length = 0;
    orThrow(await app.dispose());
    expect(app.state).toBe('disposed');
    expect(events.filter(e => e.startsWith('stop:'))).toEqual([
      'stop:healthcheck',
      'stop:worker-emails',
      'stop:worker-indexer',
      'stop:analytics',
      'stop:notifications',
      'stop:bus',
    ]);
    // Dispose hooks and kernel lazy-cleanup interleave in exact reverse
    // declaration order; blob (never initialized) is absent.
    expect(
      events.filter(e => e.startsWith('dispose:') || e.startsWith('lazyclean:') || e.startsWith('lazyinit:')),
    ).toEqual([
      'dispose:bus',
      'lazyclean:mailer',
      'lazyclean:search',
      'dispose:kv-sessions',
      'dispose:kv',
      'dispose:db-reports',
      'dispose:db',
    ]);
    // The disposed lazy handle refuses further use.
    expect(await app.services.search.get()).toMatchObject({ code: 'dot.lazy_closed' });
    // Observer saw the teardown phases.
    expect(observed.some(e => e.kind === 'phase' && e.phase === 'dispose' && e.status === 'completed')).toBe(true);
  });

  it('type-level: the guard still bites at depth', () => {
    // @ts-expect-error — api's five needs are all missing at position 1
    defineApp('bad').infra(apiUnit);
    // @ts-expect-error — healthcheck before api (one missing need among many)
    composeStressAppWithoutApi().infra(healthcheckUnit);
    expect(true).toBe(true);
  });
});

/** Same chain as composeStressApp but stops before api — guard fixture. */
function composeStressAppWithoutApi() {
  return defineApp('bad-stress')
    .infra(envUnit)
    .infra(clockUnit)
    .infra(loggerUnit)
    .infra(metricsUnit)
    .infra(dbUnit)
    .infra(reportsDbUnit)
    .infra(kvUnit)
    .infra(sessionsKvUnit)
    .infra(blobUnit)
    .infra(searchUnit)
    .infra(mailerUnit)
    .infra(busUnit)
    .infra(authUnit)
    .infra(catalogUnit)
    .infra(pricingUnit)
    .infra(inventoryUnit)
    .infra(cartUnit)
    .infra(paymentsUnit)
    .infra(ordersUnit)
    .infra(shippingUnit)
    .infra(notificationsUnit)
    .infra(analyticsUnit)
    .infra(reportingUnit)
    .infra(adminUnit);
}
