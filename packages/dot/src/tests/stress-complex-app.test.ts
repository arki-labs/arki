/**
 * Stress test: a large, realistic pip composition.
 *
 * 28 pips across 4 layers (infra → connections → domain → workers), wired
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
 * kernel-driven lazy cleanup. The 28-deep `.use()` chain itself is the
 * type-level proof: this file compiling under strict mode means the
 * builder's accumulated generics survive real-world depth.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { DotLifecycleEvent } from '../lifecycle-observer.js';
import type { Lazy } from '../pip-contract.js';
import { defineApp } from '../define-app.js';
import { lazy, pip, provide, rename, service, token } from '../pip-contract.js';

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
const ev = (tag: string): void => {
  events.push(tag);
};

const mkDb = (instance: string): Db => ({ instance, query: async sql => `${instance}:${sql}` });
const mkKv = (ns: string): KvClient => ({ ns, store: new Map(), set(k, v) { this.store.set(k, v); } });

/* ------------------------------------------------------------------ */
/* Layer 0 — infra                                                     */
/* ------------------------------------------------------------------ */

const envPip = pip({
  name: 'env',
  boot: ({ $config }) => {
    ev('boot:env');
    expect($config['FEATURE_STRESS']).toBe(true); // $config threading
    return { env: { region: 'eu-central', mailFrom: 'noreply@stress.test' } as Env };
  },
});

const clockPip = pip({
  name: 'clock',
  boot: () => {
    ev('boot:clock');
    return { clock: { now: () => 1_700_000_000 } as Clock };
  },
});

const loggerPip = pip({
  name: 'logger',
  needs: { env: service<Env>() },
  boot: ({ env }) => {
    ev('boot:logger');
    const lines: string[] = [];
    return { log: { lines, info: m => void lines.push(`[${env.region}] ${m}`) } as Log };
  },
});

const metricsPip = pip({
  name: 'metrics',
  needs: { env: service<Env>(), clock: service<Clock>() },
  boot: ({ clock }) => {
    ev('boot:metrics');
    void clock.now();
    const counts: Record<string, number> = {};
    return { metrics: { counts, incr: k => void (counts[k] = (counts[k] ?? 0) + 1) } as Metrics };
  },
});

/* ------------------------------------------------------------------ */
/* Layer 1 — connections (renames, tokens, lazies)                     */
/* ------------------------------------------------------------------ */

const dbPipFactory = (instance: string) =>
  pip({
    name: 'db',
    needs: { log: service<Log>() },
    boot: ({ log, $pip }) => {
      ev(`boot:${$pip}`);
      log.info(`db ${instance} opening`);
      return { db: mkDb(instance) };
    },
    dispose: ({ $pip }) => {
      ev(`dispose:${$pip}`);
    },
  });

const dbPip = dbPipFactory('primary');
const reportsDbPip = rename(dbPipFactory('reports'), { db: 'reportsDb' }, 'db-reports');

const kvPipFactory = (ns: string) =>
  pip({
    name: 'kv',
    boot: ({ $pip }) => {
      ev(`boot:${$pip}`);
      return provide(Kv, mkKv(ns));
    },
    dispose: ({ $pip }) => {
      ev(`dispose:${$pip}`);
    },
  });

const kvPip = kvPipFactory('main');
// Rename the token's wire key to the DERIVED token's key — rename and
// token.instance() composing is the multi-instance story for contracts.
const sessionsKvPip = rename(kvPipFactory('sessions'), { 'stress.kv': SessionsKv.key }, 'kv-sessions');

const blobPip = pip({
  name: 'blob',
  boot: () => {
    ev('boot:blob');
    return {
      blob: lazy(
        (): BlobStore => {
          ev('lazyinit:blob'); // must NEVER appear — nobody touches blob
          return { put: () => undefined };
        },
        { dispose: () => ev('lazyclean:blob') },
      ),
    };
  },
});

const searchPip = pip({
  name: 'search',
  boot: () => {
    ev('boot:search');
    return {
      search: lazy(
        (): SearchClient => {
          ev('lazyinit:search');
          const docs: string[] = [];
          return { docs, index: d => void docs.push(d) };
        },
        { dispose: () => ev('lazyclean:search') },
      ),
    };
  },
});

const mailerPip = pip({
  name: 'mailer',
  needs: { env: service<Env>() },
  boot: ({ env }) => {
    ev('boot:mailer');
    return {
      mailer: lazy(
        (): Mailer => {
          ev('lazyinit:mailer');
          const sent: string[] = [];
          return { sent, send: to => void sent.push(`${env.mailFrom} -> ${to}`) };
        },
        { dispose: () => ev('lazyclean:mailer') },
      ),
    };
  },
});

const busPip = pip({
  name: 'bus',
  boot: () => {
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
    return { bus };
  },
  start: () => ev('start:bus'),
  stop: () => ev('stop:bus'),
  dispose: () => ev('dispose:bus'),
});

/* ------------------------------------------------------------------ */
/* Layer 2 — domain                                                    */
/* ------------------------------------------------------------------ */

const authPip = pip({
  name: 'auth',
  needs: { db: service<Db>(), cache: Kv, log: service<Log>() }, // token under a free alias
  boot: ({ db, cache, log }) => {
    ev('boot:auth');
    cache.set('auth:ready', '1');
    log.info(`auth against ${db.instance}`);
    return { auth: { verify: t => t.startsWith('ok-') } as Auth };
  },
});

const catalogPip = pip({
  name: 'catalog',
  needs: { db: service<Db>(), search: service<Lazy<SearchClient>>(), log: service<Log>() },
  boot: ({ db, search }) => {
    ev('boot:catalog');
    const products: string[] = [];
    const catalog: Catalog = {
      products,
      async addProduct(id) {
        await db.query(`insert ${id}`);
        products.push(id);
        (await search.get()).index(id); // initializes search on first product
      },
    };
    return { catalog };
  },
});

const pricingPip = pip({
  name: 'pricing',
  needs: { catalog: service<Catalog>(), env: service<Env>(), clock: service<Clock>() },
  boot: ({ catalog }) => {
    ev('boot:pricing');
    return { pricing: { priceOf: id => (catalog.products.includes(id) ? 100 : 0) } as Pricing };
  },
});

const inventoryPip = pip({
  name: 'inventory',
  needs: { db: service<Db>(), stock: Kv, metrics: service<Metrics>() },
  boot: ({ metrics }) => {
    ev('boot:inventory');
    return {
      inventory: {
        reserve: () => {
          metrics.incr('inventory.reserve');
          return true;
        },
      } as Inventory,
    };
  },
});

const cartPip = pip({
  name: 'cart',
  // Consumes the DERIVED token — wired to the renamed second kv instance.
  needs: { pricing: service<Pricing>(), inventory: service<Inventory>(), sessions: SessionsKv },
  boot: ({ pricing, inventory, sessions }) => {
    ev('boot:cart');
    expect(sessions.ns).toBe('sessions'); // proves the rename+instance wiring
    const items: string[] = [];
    return {
      cart: {
        items,
        add: id => {
          if (inventory.reserve(id) && pricing.priceOf(id) > 0) items.push(id);
          sessions.set('cart', items.join(','));
        },
      } as Cart,
    };
  },
});

const paymentsPip = pip({
  name: 'payments',
  needs: { env: service<Env>(), mailer: service<Lazy<Mailer>>(), bus: service<Bus>() },
  boot: ({ bus }) => {
    ev('boot:payments');
    return {
      payments: {
        charge: async amount => {
          bus.publish('payment.charged');
          return `txn-${amount}`;
        },
      } as Payments,
    };
  },
});

const ordersPip = pip({
  name: 'orders',
  needs: { db: service<Db>(), cart: service<Cart>(), payments: service<Payments>(), bus: service<Bus>() },
  boot: ({ cart, payments, bus }) => {
    ev('boot:orders');
    const placed: string[] = [];
    return {
      orders: {
        placed,
        async place() {
          const txn = await payments.charge(cart.items.length * 100);
          placed.push(txn);
          bus.publish('order.placed');
          return txn;
        },
      } as Orders,
    };
  },
});

const shippingPip = pip({
  name: 'shipping',
  // Declares the blob need but NEVER calls .get() — blob must stay cold.
  needs: { orders: service<Orders>(), blob: service<Lazy<BlobStore>>(), bus: service<Bus>() },
  boot: ({ blob, bus }) => {
    ev('boot:shipping');
    return {
      shipping: {
        ship: async orderId => {
          void blob; // deliberately unused: laziness means no init
          bus.publish(`shipped:${orderId}`);
        },
      } as Shipping,
    };
  },
});

const notificationsPip = pip({
  name: 'notifications',
  needs: { mailer: service<Lazy<Mailer>>(), bus: service<Bus>(), auth: service<Auth>() },
  boot: ({ mailer }) => {
    ev('boot:notifications');
    return {
      notifications: {
        welcome: async user => {
          (await mailer.get()).send(user); // initializes mailer on first use
        },
      } as Notifications,
    };
  },
  start: () => ev('start:notifications'),
  stop: () => ev('stop:notifications'),
});

const analyticsPip = pip({
  name: 'analytics',
  needs: { reportsDb: service<Db>(), metrics: service<Metrics>(), bus: service<Bus>() },
  boot: ({ reportsDb, bus }) => {
    ev('boot:analytics');
    expect(reportsDb.instance).toBe('reports'); // renamed second db instance
    const seen: string[] = [];
    bus.subscribe('order.placed', () => void seen.push('order.placed'));
    return { analytics: { seen } as Analytics };
  },
  start: () => ev('start:analytics'),
  stop: () => ev('stop:analytics'),
});

const reportingPip = pip({
  name: 'reporting',
  needs: { reportsDb: service<Db>(), catalog: service<Catalog>(), orders: service<Orders>() },
  boot: ({ reportsDb, catalog, orders }) => {
    ev('boot:reporting');
    return {
      reporting: {
        dailyReport: async () =>
          `${await reportsDb.query('report')}: ${catalog.products.length} products, ${orders.placed.length} orders`,
      } as Reporting,
    };
  },
});

const adminPip = pip({
  name: 'admin',
  needs: { auth: service<Auth>(), reporting: service<Reporting>(), log: service<Log>() },
  boot: ({ reporting }) => {
    ev('boot:admin');
    return { admin: { stats: () => reporting.dailyReport() } as Admin };
  },
});

const apiPip = pip({
  name: 'api',
  needs: {
    auth: service<Auth>(),
    catalog: service<Catalog>(),
    cart: service<Cart>(),
    orders: service<Orders>(),
    admin: service<Admin>(),
  },
  configure: ctx => {
    ctx.registerRoute({ id: 'api.checkout', method: 'POST', path: '/checkout', transport: 'http' });
    ctx.registerRoute({ id: 'api.admin.stats', method: 'GET', path: '/admin/stats', transport: 'http' });
    ctx.registerService('api', 'custom');
  },
  boot: ({ auth, orders, admin }) => {
    ev('boot:api');
    return {
      api: {
        handle: async path => {
          if (!auth.verify('ok-user')) return '403';
          if (path === '/checkout') return orders.place();
          if (path === '/admin/stats') return admin.stats();
          return '404';
        },
      } as Api,
    };
  },
});

/* ------------------------------------------------------------------ */
/* Layer 3 — workers                                                   */
/* ------------------------------------------------------------------ */

const indexerPip = pip({
  name: 'worker-indexer',
  needs: { catalog: service<Catalog>(), search: service<Lazy<SearchClient>>(), bus: service<Bus>() },
  boot: () => {
    ev('boot:worker-indexer');
    return {};
  },
  start: async ({ search }) => {
    ev('start:worker-indexer');
    // Warms the search connection — second get() elsewhere must reuse it.
    await search.get();
  },
  stop: () => ev('stop:worker-indexer'),
});

const emailWorkerPip = pip({
  name: 'worker-emails',
  needs: { notifications: service<Notifications>(), bus: service<Bus>() },
  boot: () => {
    ev('boot:worker-emails');
    return {};
  },
  start: async ({ notifications }) => {
    ev('start:worker-emails');
    await notifications.welcome('alice@example.com');
  },
  stop: () => ev('stop:worker-emails'),
});

const healthcheckPip = pip({
  name: 'healthcheck',
  needs: { api: service<Api>(), db: service<Db>(), metrics: service<Metrics>() },
  boot: () => {
    ev('boot:healthcheck');
    return {};
  },
  start: async ({ db, metrics }) => {
    ev('start:healthcheck');
    await db.query('select 1');
    metrics.incr('healthcheck.ok');
  },
  stop: () => ev('stop:healthcheck'),
});

/* ------------------------------------------------------------------ */
/* The composition — 28 pips, one chain                                */
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
    .use(envPip)
    .use(clockPip)
    .use(loggerPip)
    .use(metricsPip)
    .use(dbPip)
    .use(reportsDbPip)
    .use(kvPip)
    .use(sessionsKvPip)
    .use(blobPip)
    .use(searchPip)
    .use(mailerPip)
    .use(busPip)
    .use(authPip)
    .use(catalogPip)
    .use(pricingPip)
    .use(inventoryPip)
    .use(cartPip)
    .use(paymentsPip)
    .use(ordersPip)
    .use(shippingPip)
    .use(notificationsPip)
    .use(analyticsPip)
    .use(reportingPip)
    .use(adminPip)
    .use(apiPip)
    .use(indexerPip)
    .use(emailWorkerPip)
    .use(healthcheckPip);
}

describe('stress: 28-pip commerce composition', () => {
  it('boots, runs, and tears down the full graph with exact ordering', async () => {
    events.length = 0;
    const observed: DotLifecycleEvent[] = [];

    const builder = composeStressApp();
    const app = await builder.start();
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
    expect((await app.services.search.get()).docs).toEqual(['sku-1']);
    expect((await app.services.mailer.get()).sent).toEqual(['noreply@stress.test -> alice@example.com']);
    expect(events.filter(e => e.startsWith('lazyinit:'))).toHaveLength(2); // still single-flight

    /* ---- manifest: observed wiring at scale ---- */
    const m = app.manifest;
    expect(m.pips.map(p => p.name)).toEqual([...DECLARATION_ORDER]);
    expect(m.routes.map(r => r.id)).toEqual(['api.checkout', 'api.admin.stats']);
    expect(m.dependencies).toEqual(
      expect.arrayContaining([
        { from: 'logger', to: 'env', kind: 'requires' },
        { from: 'auth', to: 'kv', kind: 'requires' },
        { from: 'cart', to: 'kv-sessions', kind: 'requires' }, // derived token → renamed pip
        { from: 'analytics', to: 'db-reports', kind: 'requires' }, // renamed db instance
        { from: 'api', to: 'admin', kind: 'requires' },
        { from: 'healthcheck', to: 'api', kind: 'requires' },
      ]),
    );
    // Every edge points backward in declaration order (services flow forward).
    for (const edge of m.dependencies) {
      const from = DECLARATION_ORDER.indexOf(edge.from as (typeof DECLARATION_ORDER)[number]);
      const to = DECLARATION_ORDER.indexOf(edge.to as (typeof DECLARATION_ORDER)[number]);
      expect(to, `${edge.from} -> ${edge.to} must point to an earlier pip`).toBeLessThan(from);
    }

    /* ---- diagnostics + timeline ---- */
    expect(app.diagnostics.pips).toHaveLength(28);
    expect(app.diagnostics.pips.every(p => p.status === 'ok')).toBe(true);
    expect(app.diagnostics.issues).toEqual([]);
    const timeline = app.timeline();
    expect(timeline).toContain('stress-commerce');
    expect(timeline).toContain('worker-indexer');

    /* ---- teardown: reverse stop, then reverse dispose + lazy cleanup ---- */
    events.length = 0;
    await app.dispose();
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
    expect(events.filter(e => e.startsWith('dispose:') || e.startsWith('lazyclean:') || e.startsWith('lazyinit:'))).toEqual([
      'dispose:bus',
      'lazyclean:mailer',
      'lazyclean:search',
      'dispose:kv-sessions',
      'dispose:kv',
      'dispose:db-reports',
      'dispose:db',
    ]);
    // The disposed lazy handle refuses further use.
    await expect(app.services.search.get()).rejects.toThrow(/disposed/);
    // Observer saw the teardown phases.
    expect(observed.some(e => e.kind === 'phase' && e.phase === 'dispose' && e.status === 'completed')).toBe(true);
  });

  it('type-level: the guard still bites at depth', () => {
    // @ts-expect-error — api's five needs are all missing at position 1
    defineApp('bad').use(apiPip);
    // @ts-expect-error — healthcheck before api (one missing need among many)
    composeStressAppWithoutApi().use(healthcheckPip);
    expect(true).toBe(true);
  });
});

/** Same chain as composeStressApp but stops before api — guard fixture. */
function composeStressAppWithoutApi() {
  return defineApp('bad-stress')
    .use(envPip)
    .use(clockPip)
    .use(loggerPip)
    .use(metricsPip)
    .use(dbPip)
    .use(reportsDbPip)
    .use(kvPip)
    .use(sessionsKvPip)
    .use(blobPip)
    .use(searchPip)
    .use(mailerPip)
    .use(busPip)
    .use(authPip)
    .use(catalogPip)
    .use(pricingPip)
    .use(inventoryPip)
    .use(cartPip)
    .use(paymentsPip)
    .use(ordersPip)
    .use(shippingPip)
    .use(notificationsPip)
    .use(analyticsPip)
    .use(reportingPip)
    .use(adminPip);
}
