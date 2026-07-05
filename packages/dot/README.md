# @arki/dot

> TypeScript-first application composition framework for the ARKI package family.

`@arki/dot` is the kernel that wires **pips**, lifecycle hooks, dependency
injection, and diagnostics into a deterministic application boot. It gives
library authors a stable contract for declaring how their package
participates in an app, and gives app developers a single place to wire
those packages together — with the type checker verifying the wiring before
anything runs.

## What is a pip?

A **pip** is the unit a DOT app is built from — one self-describing,
lifecycle-aware piece of an application. Each pip:

- declares a **name**, **version**, and the services it **needs** as a shape
  of type witnesses;
- **provides** services by returning them from its `boot` hook — provides
  are *inferred from the return type*, never declared separately;
- runs a **5-hook lifecycle** — `configure` → `boot` → `start` → `stop` → `dispose`;
- **publishes typed services** to a shared, type-safe registry that later
  pips can read from;
- **composes deterministically** — pips boot in declaration order and
  dispose in reverse.

The name comes from the small dots on dice, dominoes, and music notation:
each pip is one small mark, and the *combination* of pips is what gives the
app its value. Two pips on a die make a value of two; six pips make six. The
pips **are** the app — not optional add-ons to a hidden core.

```ts
import { defineApp } from '@arki/dot';
import { env } from '@arki/env/dot';      // env pip
import { db } from '@arki/db/dot';        // db pip
import { kv } from '@arki/kv/dot';        // kv pip

const app = await defineApp('orders')
  .use(env({ schema: { /* ... */ } }))     // 1st pip — provides services.env
  .use(db({ relations }))                  // 2nd pip — provides services.db
  .use(kv({ url: process.env.KV_URL! }))   // 3rd pip — provides services.kv
  .boot();                                  // pips boot in declaration order

await app.services.db.query(/* ... */);
await app.dispose();                       // pips dispose in REVERSE order
```

Each `/dot` subpath exports a **pip** for that package. The subpath names
the framework the adapter targets (DOT), not the unit (which is a pip).

> **Why not "plugin"?** Plugins suggest *optional add-ons* to a core. DOT's
> reality is the opposite: there is no hidden core — the pips *are* the app.
> "Pip" names that truth, and ties the framework to the DOT name etymologically
> (a dot, a pip, a small mark that gains meaning by combining with others).

## Installation

```bash
npm install @arki/dot
# or
bun add @arki/dot
```

## Quick start

```ts
import { defineApp, pip, service } from '@arki/dot';

type Db = { query(sql: string): Promise<unknown[]> };

const dbPip = pip({
  name: 'database',
  async boot() {
    const db = await openDb(process.env.DATABASE_URL);
    return { db };                    // ← this IS the provides declaration
  },
  async dispose({ db }) {
    await db.close();
  },
});

const billingPip = pip({
  name: 'billing',
  version: '1.0.0',
  needs: { db: service<Db>() },     // typed injection — destructure in hooks
  configure(ctx) {
    // Validate config, register schemas, no I/O.
  },
  async boot({ db }) {
    // Open connections. The return value IS what this pip provides.
    return { stripe: makeStripeClient(db) };
  },
  async start({ stripe }) {
    // Begin processing — workers, subscriptions, schedulers.
  },
  async stop({ stripe }) {
    // Stop processing — drain workers, unsubscribe.
  },
  async dispose({ stripe }) {
    // Close connections, free resources.
  },
});

const app = await defineApp('acme')
  .use(dbPip)          // providers before consumers — enforced at compile time
  .use(billingPip)
  .start();

// app.manifest, app.diagnostics — agent-friendly envelopes.

await app.stop();
await app.dispose();
```

There is no registry to configure, no decorators, no reflection. The `needs`
shape is the injection contract; the `boot` return type is the provision
contract; the builder's type-level guard connects the two.

## Dependency injection

### Needs are witnesses, provides are inferred

`service<T>()` creates a phantom **type witness** — a runtime no-op that
carries `T` at the type level. The property name you give it is your local
alias *and* (for anonymous witnesses) the wire key:

```ts
const search = pip({
  name: 'search',
  needs: {
    db: service<Db>(),                 // wire key 'db', local alias 'db'
    log: service<Logger>(),            // wire key 'log'
  },
  async boot({ db, log, $app }) {      // $app/$pip/$config: kernel context
    log.info(`indexing for ${$app}`);
    return { search: await buildIndex(db) };
  },
});
```

`start`, `stop`, and `dispose` additionally receive the pip's **own
provides** — and because teardown runs in reverse declaration order, a pip's
needs are still alive in its `dispose`:

```ts
async dispose({ search, db }) {        // own provide + still-live need
  await search.flush(db);
},
```

### Wrong wiring does not compile

Declaration order IS boot order. The `.use()` guard makes unsatisfied needs,
type mismatches, and key collisions **compile errors at the call site**:

```ts
defineApp('shop')
  .use(billing)      // ❌ "Expected 2 arguments, but got 1."
  .use(database);    //    billing's `db` need has no earlier provider

defineApp('shop')
  .use(database)
  .use(database2);   // ❌ collision: two providers of wire key 'db'
```

Reordering the first example — or `rename`-ing one provider in the second —
makes both compile. The kernel re-validates at runtime with coded errors
(`E012` unsatisfied need, `E013` collision, `E014` reserved key) for
erased/dynamic composition, with full rollback of already-booted pips.

There is no dependency graph to debug and **cycles are unrepresentable**:
services flow strictly forward through the `.use()` chain. If two pips need
each other's services, that's a design smell the type system surfaces
immediately — merge them, or extract the shared piece into a third pip both
consume.

### Tokens — cross-package service contracts

An anonymous `service<T>()` couples consumer and provider by property name.
When a contract spans packages, a **token** owns the wire key and the local
alias becomes free choice:

```ts
// The package that owns the contract exports the token:
export const Db = token<NodePgDatabase<Schema>>()('arki.db');

// A provider publishes under the token's key:
const database = pip({
  name: 'database',
  async boot() {
    return provide(Db, await connect());   // → { 'arki.db': NodePgDatabase }
  },
});

// Any consumer, any package, any local alias:
const reports = pip({
  name: 'reports',
  needs: { warehouse: Db },                // wire key 'arki.db', alias yours
  async boot({ warehouse }) { /* ... */ },
});
```

### Multi-instance with `rename`

Mounting an adapter twice would collide on its wire keys — loudly, at
compile time. `rename` is the multi-instance primitive, and
`Token.instance()` derives the matching contract:

```ts
const ReportsDb = Db.instance('reports');  // token for key 'arki.db#reports'

const app = await defineApp('shop')
  .use(database({ url: PRIMARY_URL }))
  .use(rename(
    database({ url: REPLICA_URL }),
    { 'arki.db': ReportsDb.key },          // republish under the derived key
    'reports-db',                          // distinct pip name
  ))
  .use(pip({
    name: 'analytics',
    needs: { primary: Db, replica: ReportsDb },
    async boot({ primary, replica }) { /* two live instances, both typed */ },
  }))
  .boot();
```

Renames compose left-to-right and are applied at publish time — collision
checks see the final keys.

### Lazy services

`lazy(init, { dispose })` publishes a **handle** instead of an open
resource. Initialization runs on first `get()` (memoized, single-flight;
failed attempts retry). Never-touched handles never initialize — and the
kernel auto-disposes initialized ones during teardown, *after* the
publishing pip's own `dispose` hook, even if that pip has none:

```ts
const search = pip({
  name: 'search',
  async boot() {
    return {
      search: lazy(() => connectToElastic(), {
        dispose: client => client.close(),
      }),
    };
  },
});
```

Consumers that shouldn't care whether a provider is eager or lazy declare a
**lifting witness** — `service.lazy<T>()` always delivers a `Lazy<T>`
handle, wrapping eager provides and passing lazy ones through by identity:

```ts
const suggestions = pip({
  name: 'suggestions',
  needs: { search: service.lazy<SearchClient>() },
  async start({ search }) {
    const client = await search.get();     // first access initializes
    /* ... */
  },
});
```

Swapping the search provider between eager and lazy is invisible to every
consumer — the wiring guard accepts both shapes against the same witness.

### Kernel context — the reserved `$` namespace

Every service-carrying hook context includes `$app` (app name), `$pip` (pip
name), and `$config` (the `defineApp(name, { config })` bag). The `$` prefix
is enforced as reserved: `pip()` rejects `$`-prefixed needs aliases and
publish keys at compile time, and the kernel re-validates at runtime
(`DOT_LIFECYCLE_E014`) — kernel keys can never be shadowed.

## A complex setup

A distilled commerce platform showing everything above working together.
(The package's stress-test suite boots a 28-pip version of this and asserts
exact boot/teardown ordering.)

```ts
import { defineApp, lazy, pip, provide, rename, service, token } from '@arki/dot';

// ── contracts.ts — tokens owned by their respective packages ─────────
export const Env = token<AppEnv>()('shop.env');
export const Db = token<DbHandle>()('shop.db');
export const ReportsDb = Db.instance('reports');
export const Cache = token<CacheHandle>()('shop.cache');
export const Bus = token<MessageBus>()('shop.bus');

// ── infrastructure pips ───────────────────────────────────────────────
const env = pip({
  name: 'env',
  boot: ({ $config }) => provide(Env, parseEnv($config)),
});

const telemetry = pip({
  name: 'telemetry',
  needs: { env: Env },
  boot: ({ env }) => ({ metrics: makeMetrics(env.OTEL_ENDPOINT) }),
  dispose: ({ metrics }) => metrics.flush(),
});

const database = (url: string) =>
  pip({
    name: 'database',
    needs: { metrics: service<Metrics>() },
    async boot({ metrics }) {
      return provide(Db, await connectPg(url, { metrics }));
    },
    async dispose(ctx) {
      await ctx[Db.key].end();       // own provide, published under the token key
    },
  });

const cache = pip({
  name: 'cache',
  needs: { env: Env },
  boot: ({ env }) => provide(Cache, connectRedis(env.REDIS_URL)),
  dispose: async ctx => ctx[Cache.key].quit(),
});

const searchCluster = pip({
  name: 'search-cluster',
  needs: { env: Env },
  boot: ({ env }) => ({
    // Expensive external cluster — only opens if something get()s it.
    search: lazy(() => connectElastic(env.ELASTIC_URL), {
      dispose: client => client.close(),
    }),
  }),
});

const bus = pip({
  name: 'bus',
  boot: () => provide(Bus, makeInMemoryBus()),
});

// ── domain pips ───────────────────────────────────────────────────────
const catalog = pip({
  name: 'catalog',
  needs: {
    db: Db,
    cache: Cache,
    search: service.lazy<SearchClient>(),   // eager or lazy provider — same code
  },
  boot: ({ db, cache, search }) => ({
    catalog: makeCatalog({ db, cache, search }),
  }),
});

const checkout = pip({
  name: 'checkout',
  needs: { db: Db, bus: Bus, catalog: service<Catalog>() },
  boot: ({ db, bus, catalog }) => ({
    checkout: makeCheckout({ db, bus, catalog }),
  }),
});

const reporting = pip({
  name: 'reporting',
  needs: { replica: ReportsDb, catalog: service<Catalog>() },
  boot: ({ replica, catalog }) => ({ reporting: makeReporting(replica, catalog) }),
});

// ── process pips — real work happens in start/stop ───────────────────
const outboxWorker = pip({
  name: 'outbox-worker',
  needs: { db: Db, bus: Bus },
  boot: ({ db, bus }) => ({ outbox: makeOutbox(db, bus) }),
  start: ({ outbox }) => outbox.startPolling(),
  stop: ({ outbox }) => outbox.drain(),      // stop processing, keep resources
});

const http = pip({
  name: 'http',
  needs: {
    env: Env,
    catalog: service<Catalog>(),
    checkout: service<Checkout>(),
    reporting: service<Reporting>(),
  },
  async boot({ env, catalog, checkout, reporting }) {
    return { server: buildServer({ port: env.PORT, catalog, checkout, reporting }) };
  },
  start: ({ server }) => server.listen(),
  stop: ({ server }) => server.close(),
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

## Testing pips

`testPip` is the typed unit-test builder: satisfy a pip's needs directly
with fakes — no real providers, no dependency chain — and the compiler
holds the same line it holds in production. A missing fake means `boot()`
does not compile; a fake of the wrong shape fails at the `.provide()`
call site:

```ts
import { testPip } from '@arki/dot/test-harness';

const app = await testPip(catalog)
  .provide(Db, fakeDb)             // token need
  .provide('cache', fakeKv)        // anonymous need — wire key is the alias
  .boot();

expect(app.services.catalog.list()).toEqual([]);
await app.dispose();
```

The fakes are published by a synthetic first pip, so lifecycle semantics
are the real kernel's — reverse-order teardown, lazy auto-dispose, and
`$config` all behave exactly as in production. `service.lazy<T>()` needs
accept a plain `T` fake (lifted automatically) or `lazyOf(value)`.

For integration tests across several real pips, `testApp([...pips])`
builds an app from an erased pip array (runtime validation only), and
`bootTestApp` is the one-line boot-and-return variant.

## Operations

Two kernel helpers close the gap between "boots on my machine" and "runs
under a process manager":

```ts
const app = await defineApp('shop', { hookTimeoutMs: 30_000 })
  .use(/* ... */)
  .start();

hookSignals(app); // SIGTERM/SIGINT → stop() + dispose() → re-raise
```

- **`hookSignals(app, { timeoutMs? })`** — graceful shutdown wiring. The
  first signal drains the app (bounded by `timeoutMs`, default 10 s) and
  re-raises itself so the exit status keeps standard signal semantics; a
  second signal falls through to the runtime default (immediate kill).
  Returns an unhook function.
- **`hookTimeoutMs`** — a per-hook watchdog. Any `boot`/`start`/`stop`/
  `dispose` hook exceeding the budget fails with `DOT_LIFECYCLE_E015`
  naming the pip and hook, and the kernel applies its normal rollback or
  aggregation rules. Your app cannot hang silently at boot.

## Pip authoring

`pip(config)` accepts a `needs` shape plus five lifecycle hooks. Hook
contexts carry the needed services (typed, under your local aliases) and
`$`-prefixed kernel keys (`$app`, `$pip`, `$config`):

| Hook        | Purpose                                                             |
| ----------- | ------------------------------------------------------------------- |
| `configure` | Validate static config; declare schemas, routes, services. No I/O.  |
| `boot`      | Open connections; the returned record is what the pip provides.     |
| `start`     | Begin processing (workers, subscribers, schedulers).                |
| `stop`      | Stop processing in reverse declaration order.                       |
| `dispose`   | Free resources after `stop`; lazy handles auto-clean afterwards.    |

Wiring is compile-time checked: `.use(pip)` fails to typecheck when the
pip's needs aren't satisfied by earlier `.use()` calls, or when its
provides collide with an existing wire key. `rename(pip, { db: 'reportsDb' })`
mounts a second instance of an adapter without collision; `token<T>()('key')`
shares a service contract across packages; `lazy(() => open(), { dispose })`
defers an expensive open until first `get()` — never-touched services never
initialize, and the kernel auto-disposes initialized ones. Declaration
order is boot order — same input, same order, every time.

## Lifecycle

`defineApp(name)` returns a builder. Calling `.use(pip)` accumulates
pips. The lifecycle then flows:

```text
defined ──configure()──▶ configured ──boot()──▶ booted ──start()──▶ started
                                                                       │
                       disposed ◀──dispose()── stopped ◀──stop()───────┘
```

`boot()` runs `configure()` implicitly if you skipped it. `start()` runs
`boot()` implicitly. `stop()` and `dispose()` always run in reverse
declaration order, even when an earlier hook failed — failure isolation is
part of the contract. A boot failure rolls back every already-booted pip
before throwing.

Runtime failures carry stable codes (`DotLifecycleError.code`):

| Code                 | Meaning                                              |
| -------------------- | ---------------------------------------------------- |
| `DOT_LIFECYCLE_E011` | Pip registered twice.                                |
| `DOT_LIFECYCLE_E012` | A need has no provider among earlier pips.           |
| `DOT_LIFECYCLE_E013` | A published wire key collides with an earlier one.   |
| `DOT_LIFECYCLE_E014` | A service key uses the reserved `$` (kernel) prefix. |
| `DOT_LIFECYCLE_E015` | A hook exceeded the `hookTimeoutMs` watchdog.        |

(Full table including hook-failure codes: [docs/lifecycle.md](./docs/lifecycle.md).)

## CLI

`@arki/dot` ships a small CLI for scaffolding and inspecting apps:

```bash
# Scaffold a minimal DOT app (package.json, tsconfig, app entrypoint,
# env schema, AGENTS.md, README, gitignore, vitest boot test).
dot new my-app

# Preview the file operations without writing anything.
dot new my-app --dry-run --json | jq '.operations'

# Print the app manifest as a structured envelope.
dot explain --app ./my-app.ts

# Run boot-time diagnostics; non-zero exit if any check fails.
dot doctor --app ./my-app.ts

# Render the pip graph as Mermaid flowchart source. explain shows
# declaration (= boot) order; doctor boots and shows the OBSERVED wiring.
dot doctor --app ./my-app.ts --graph

# Every command supports --json for agent-friendly output.
dot explain --app ./my-app.ts --json | jq '.data.pips'
```

The CLI emits the same envelope shape as the in-process diagnostics snapshot
(`app.diagnostics`), so the same downstream tools can consume either. The
manifest's dependency edges are **observed, not declared** — the kernel
records which pip's published service satisfied which need during boot.

### `dot new <app-name>`

Scaffolds a minimal DOT app under `<app-name>/` (override with `--target`).
The scaffold ships a `defineApp(...)` entrypoint wired to `@arki/env/dot`,
a vitest that boots the app and asserts the manifest shape, and an
`AGENTS.md` documenting verification commands and the public/private
boundary for agents working in the generated tree. Pass `--dry-run --json`
to inspect the exact file operations (path, action, contentHash,
contentBytes, reason) before committing them to disk; `--force`
overwrites pre-existing files in the target directory.

Templates live at [`templates/app-minimal/`](./templates/app-minimal) and
ship with the published tarball.

## Architecture

`@arki/dot` is intentionally small: it defines the contracts (pip shape,
lifecycle hooks, manifest schema, diagnostics envelope) and runs them. Adapters
that bridge databases, queues, auth providers, and HTTP routers live in their
own packages and consume `@arki/dot` as a peer dependency:

```ts
import { env } from '@arki/env/dot';
import { db } from '@arki/db/dot';
import { kv } from '@arki/kv/dot';
import { eventSourcing } from '@arki/event-sourcing/dot';
```

This keeps the kernel free of optional dependencies and lets each adapter
ship at its own cadence.

## Documentation

The full docs live in [`docs/`](./docs):

- [Principles](./docs/principles.md) — **read first.** The five rules every
  API, error, and PR is measured against. Slightly playful, very precise.
- [Quickstart](./docs/quickstart.md) — boot your first app in five minutes.
- [Pip authoring](./docs/pip-authoring.md) — write your own pip.
- [Lifecycle](./docs/lifecycle.md) — the 5-hook contract, idempotency, error codes.
- [Diagnostics](./docs/diagnostics.md) — `app.manifest`, `app.diagnostics`,
  `dot explain`, `dot doctor`.
- [Adapter authoring](./docs/adapter-authoring.md) — expose your package as
  a DOT pip.
- [Agent guide](./docs/agent-guide.md) — how coding agents inspect, modify,
  and verify DOT apps.
- [Release policy](./docs/release-policy.md) — SemVer and deprecation.

Agent-discoverable index: [`llms.txt`](./llms.txt).

## License

MIT — see [LICENSE](./LICENSE).
