# A complex setup

One app with many moving parts at once: tokens shared across packages, two
databases through `rename`, a lazy search client, an outbox worker and an
HTTP server that starts last. Read [Dependency injection](./di.md) first;
this page assumes needs, `provides`, tokens and `rename`.

```text
boot / start ──────────────────────────────────────────────────────────▶
 env → telemetry → database → reports-db → cache → searchCluster → bus
     → catalog → checkout → reporting → outboxWorker → http
◀────────────────────────────────────────────────────────── stop / dispose
```

Why this order: each line needs only what sits above it. The HTTP server is
last on the way up, so it takes no request before its services exist. It is
first on the way down, so it stops taking requests before they go away.

A distilled commerce platform showing everything above working together.
(The package's stress-test suite boots a 28-plugin version of this and asserts
exact boot/teardown ordering.)

```ts
import { defineApp, lazy, plugin, rename, service, token } from '@arki/dot';
import { isFailure } from '@arki/failure';

// ── stand-ins for your own modules ──────────────────────────────────────
type AppEnv = { OTEL_ENDPOINT: string; REDIS_URL: string; ELASTIC_URL: string; PORT: number };
type Metrics = { flush(): Promise<void> };
type DbHandle = { end(): Promise<void> };
type CacheHandle = { quit(): Promise<void> };
type MessageBus = { publish(topic: string, body: unknown): Promise<void> };
type SearchClient = { close(): Promise<void> };
type Catalog = { list(): Promise<unknown[]> };
type Checkout = { pay(orderId: string): Promise<void> };
type Reporting = { daily(): Promise<unknown[]> };
declare function parseEnv(config: unknown): AppEnv;
declare function makeMetrics(endpoint: string): Metrics;
declare function connectPg(url: string, options: { metrics: Metrics }): DbHandle;
declare function connectRedis(url: string): CacheHandle;
declare function connectElastic(url: string): Promise<SearchClient>;
declare function makeInMemoryBus(): MessageBus;
declare function makeCatalog(deps: object): Catalog;
declare function makeCheckout(deps: object): Checkout;
declare function makeReporting(replica: DbHandle, catalog: Catalog): Reporting;
declare function makeOutbox(db: DbHandle, bus: MessageBus): { startPolling(): void; drain(): Promise<void> };
declare function buildServer(options: object): { listen(): Promise<void>; close(): Promise<void> };
declare const PRIMARY_URL: string;
declare const REPLICA_URL: string;

// ── contracts.ts — tokens owned by their respective packages ─────────
export const Env = token<AppEnv>()('shop.env');
export const Db = token<DbHandle>()('shop.db');
export const ReportsDb = Db.instance('reports');
export const Cache = token<CacheHandle>()('shop.cache');
export const Bus = token<MessageBus>()('shop.bus');

// ── infrastructure plugins ───────────────────────────────────────────────
const env = plugin({
  name: 'env',
  provides: { [Env.key]: ({ $config }) => parseEnv($config) },
});

const telemetry = plugin({
  name: 'telemetry',
  needs: { env: Env },
  provides: { metrics: ({ env }) => makeMetrics(env.OTEL_ENDPOINT) },
  dispose: async ({ metrics }) => {
    await metrics.flush();
    return undefined;
  },
});

const database = (url: string) =>
  plugin({
    name: 'database',
    needs: { metrics: service<Metrics>() },
    provides: { [Db.key]: ({ metrics }) => connectPg(url, { metrics }) },
    async dispose(ctx) {
      await ctx[Db.key].end(); // own provide, published under the token key
    },
  });

const cache = plugin({
  name: 'cache',
  needs: { env: Env },
  provides: { [Cache.key]: ({ env }) => connectRedis(env.REDIS_URL) },
  dispose: async ctx => {
    await ctx[Cache.key].quit();
    return undefined;
  },
});

const searchCluster = plugin({
  name: 'search-cluster',
  needs: { env: Env },
  provides: {
    // Expensive external cluster — only opens if something get()s it.
    search: ({ env }) =>
      lazy(() => connectElastic(env.ELASTIC_URL), {
        dispose: client => client.close(),
      }),
  },
});

const bus = plugin({
  name: 'bus',
  provides: { [Bus.key]: () => makeInMemoryBus() },
});

// ── domain plugins ───────────────────────────────────────────────────────
const catalog = plugin({
  name: 'catalog',
  needs: {
    db: Db,
    cache: Cache,
    search: service.lazy<SearchClient>(), // eager or lazy provider — same code
  },
  provides: {
    catalog: ({ db, cache, search }) => makeCatalog({ db, cache, search }),
  },
});

const checkout = plugin({
  name: 'checkout',
  needs: { db: Db, bus: Bus, catalog: service<Catalog>() },
  provides: {
    checkout: ({ db, bus, catalog }) => makeCheckout({ db, bus, catalog }),
  },
});

const reporting = plugin({
  name: 'reporting',
  needs: { replica: ReportsDb, catalog: service<Catalog>() },
  provides: { reporting: ({ replica, catalog }) => makeReporting(replica, catalog) },
});

// ── process plugins — real work happens in start/stop ───────────────────
const outboxWorker = plugin({
  name: 'outbox-worker',
  needs: { db: Db, bus: Bus },
  provides: { outbox: ({ db, bus }) => makeOutbox(db, bus) },
  start: ({ outbox }) => {
    outbox.startPolling();
    return undefined;
  },
  stop: async ({ outbox }) => {
    await outbox.drain();
    return undefined;
  }, // stop processing, keep resources
});

const http = plugin({
  name: 'http',
  needs: {
    env: Env,
    catalog: service<Catalog>(),
    checkout: service<Checkout>(),
    reporting: service<Reporting>(),
  },
  provides: {
    server: ({ env, catalog, checkout, reporting }) => buildServer({ port: env.PORT, catalog, checkout, reporting }),
  },
  start: async ({ server }) => {
    await server.listen();
    return undefined;
  },
  stop: async ({ server }) => {
    await server.close();
    return undefined;
  },
});

// ── composition — the order IS the architecture ──────────────────────
const app = await defineApp('shop', { config: process.env })
  .use(env)
  .use(telemetry)
  .use(database(PRIMARY_URL))
  .use(rename(database(REPLICA_URL), { 'shop.db': ReportsDb.key }, 'reports-db'))
  .use(cache)
  .use(searchCluster)
  .use(bus)
  .use(catalog)
  .use(checkout)
  .use(reporting)
  .use(outboxWorker)
  .use(http)
  .start();
if (isFailure(app)) throw new Error(app.code);

// SIGTERM → dispose() cascades stop() first, tears down in exact reverse:
// http, outbox (drained), reporting, checkout, catalog, bus,
// search cluster (only if it ever initialized), cache, reports-db,
// primary db, telemetry, env.
process.on('SIGTERM', () => void app.dispose());
```

What the type checker is holding for you in that chain:

- move `.use(catalog)` above `.use(cache)` → compile error at that line;
- delete `.use(bus)` → compile errors at `checkout` and `outboxWorker`;
- mount the second `database(...)` without `rename` → collision error;
- change `makeCatalog` to return something that isn't a `Catalog` →
  every consumer's `.use()` flags the mismatch.

Concurrent lifecycle calls are safe: transitions are serialized on one
queue, same-phase calls coalesce onto one in-flight promise, and a
`dispose()` racing a slow `start()` always runs after it — the app ends
`disposed`, never resurrected.

## Where the adapters live

`@arki/dot` is intentionally small: it defines the contracts (plugin shape,
lifecycle hooks, manifest schema, diagnostics envelope) and runs them. Adapters
that bridge databases, queues, auth providers, and HTTP routers live in their
own packages and consume `@arki/dot` as a peer dependency:

```ts skip="adapter packages depend on @arki/dot, so dot cannot import them"
import { db } from '@arki/db/dot';
import { env } from '@arki/dot/env';
import { journal } from '@arki/journal/dot';
import { kv } from '@arki/kv/dot';
```

This keeps the kernel free of optional dependencies and lets each adapter
ship at its own cadence.
