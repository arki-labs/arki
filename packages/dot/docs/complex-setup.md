# A complex setup

One app with many moving parts at once: tokens shared across packages, two
databases through `rename`, a lazy search client, an outbox worker and an
HTTP server that starts last. Read [Dependency injection](./di.md) first;
this page assumes needs, `provides`, tokens and `rename`.

```text
boot / start ──────────────────────────────────────────────────────────▶
 infra        env → telemetry → database → reports-db → cache → searchCluster → bus
 features     catalog → checkout → reporting
 entrypoints  outboxWorker → http
◀────────────────────────────────────────────────────────── stop / dispose
```

Why this order: each line needs only what sits above it. Infra is what the
domain talks to, features are the domain, and entrypoints drive it from
outside. The HTTP server is
last on the way up, so it takes no request before its services exist. It is
first on the way down, so it stops taking requests before they go away.

A distilled commerce platform showing everything above working together.
(The package's stress-test suite boots a 28-unit version of this and asserts
exact boot/teardown ordering.)

```ts
import { defineApp, entrypoint, infra, lazy, rename, service, token } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { isFailure } from '@arki/failure';

// ── stand-ins for your own modules ──────────────────────────────────────
type AppEnv = { OTEL_ENDPOINT: string; REDIS_URL: string; ELASTIC_URL: string; PORT: number };
type Metrics = { flush(): Promise<void> };
type DbHandle = { end(): Promise<void> };
type CacheHandle = { quit(): Promise<void> };
type MessageBus = { publish(topic: string, body: unknown): Promise<void> };
type SearchClient = { close(): Promise<void> };
type Catalog = { list(): Promise<unknown[]> };
type Checkout = { pay(orderId: string): Promise<undefined> };
type Reporting = { daily(): Promise<unknown[]> };
declare function parseEnv(config: unknown): AppEnv;
declare function makeMetrics(endpoint: string): Metrics;
declare function connectPg(url: string, options: { metrics: Metrics }): DbHandle;
declare function connectRedis(url: string): CacheHandle;
declare function connectElastic(url: string): Promise<SearchClient>;
declare function makeInMemoryBus(): MessageBus;
declare function makeCatalog(deps: object): Catalog;
declare function makeCheckout(deps: object): Checkout;
declare function makeReporting(replica: DbHandle, catalog: object): Reporting;
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

// ── infrastructure units ───────────────────────────────────────────────
const env = infra({
  name: 'env',
  provides: { [Env.key]: ({ $config }) => parseEnv($config) },
});

const telemetry = infra({
  name: 'telemetry',
  needs: { env: Env },
  provides: { metrics: ({ env }) => makeMetrics(env.OTEL_ENDPOINT) },
  dispose: async ({ metrics }) => {
    await metrics.flush();
    return undefined;
  },
});

const database = (url: string) =>
  infra({
    name: 'database',
    needs: { metrics: service<Metrics>() },
    provides: { [Db.key]: ({ metrics }) => connectPg(url, { metrics }) },
    async dispose(ctx) {
      await ctx[Db.key].end(); // own provide, published under the token key
    },
  });

const cache = infra({
  name: 'cache',
  needs: { env: Env },
  provides: { [Cache.key]: ({ env }) => connectRedis(env.REDIS_URL) },
  dispose: async ctx => {
    await ctx[Cache.key].quit();
    return undefined;
  },
});

const searchCluster = infra({
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

const bus = infra({
  name: 'bus',
  provides: { [Bus.key]: () => makeInMemoryBus() },
});

// ── features — the domain ─────────────────────────────────────────────
const catalog = defineFeature('catalog')
  .needs({
    db: Db,
    cache: Cache,
    search: service.lazy<SearchClient>(), // eager or lazy provider — same code
  })
  .usecases({
    list:
      ({ db, cache, search }) =>
      () =>
        makeCatalog({ db, cache, search }).list(),
  })
  .provides({ catalog: ({ usecases }) => ({ list: usecases.list }) })
  .entrypoints();

const checkout = defineFeature('checkout')
  .needs({ db: Db, bus: Bus, catalog: catalog.provides.catalog })
  .usecases({
    pay:
      ({ db, bus, catalog }) =>
      (orderId: string) =>
        makeCheckout({ db, bus, catalog }).pay(orderId),
  })
  .provides({ checkout: ({ usecases }) => ({ pay: usecases.pay }) })
  .entrypoints();

const reporting = defineFeature('reporting')
  .needs({ replica: ReportsDb, catalog: catalog.provides.catalog })
  .usecases({
    daily:
      ({ replica, catalog }) =>
      () =>
        makeReporting(replica, catalog).daily(),
  })
  .provides({ reporting: ({ usecases }) => ({ daily: usecases.daily }) })
  .entrypoints();

// ── entrypoints — real work happens in start/stop ─────────────────────
const outboxWorker = entrypoint({
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

const http = entrypoint({
  name: 'http',
  needs: {
    env: Env,
    catalog: catalog.provides.catalog,
    checkout: checkout.provides.checkout,
    reporting: reporting.provides.reporting,
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
  .infra(
    env,
    telemetry,
    database(PRIMARY_URL),
    rename(database(REPLICA_URL), { 'shop.db': ReportsDb.key }, 'reports-db'),
    cache,
    searchCluster,
    bus,
  )
  .features([catalog, checkout, reporting])
  .entrypoints(outboxWorker, http)
  .start();
if (isFailure(app)) throw new Error(app.code);

// SIGTERM → dispose() cascades stop() first, tears down in exact reverse:
// http, outbox (drained), reporting, checkout, catalog, bus,
// search cluster (only if it ever initialized), cache, reports-db,
// primary db, telemetry, env.
process.on('SIGTERM', () => void app.dispose());
```

What the type checker is holding for you in that chain:

- list `checkout` before `catalog` → compile error at `.features(...)`;
- delete `bus` → compile errors at `.features(...)` (for `checkout`) and `.entrypoints(...)` (for `outboxWorker`);
- mount the second `database(...)` without `rename` → collision error;
- change `makeCatalog` to return something that isn't a `Catalog` →
  every consumer's step flags the mismatch.

Concurrent lifecycle calls are safe: transitions are serialized on one
queue, same-phase calls coalesce onto one in-flight promise, and a
`dispose()` racing a slow `start()` always runs after it — the app ends
`disposed`, never resurrected.

## Where the adapters live

`@arki/dot` is intentionally small: it defines the contracts (unit shape,
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
