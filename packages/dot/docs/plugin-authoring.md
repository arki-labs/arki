# Plugin Authoring

A plugin is authored with `plugin(config)` — a name, an optional `needs` shape,
and up to five lifecycle hooks. The kernel runs the hooks in declaration
order (`configure → boot → start`) and in reverse declaration order for
cleanup (`stop → dispose`). See [Lifecycle](./lifecycle.md) for the full
contract.

## Anatomy

```ts
import { plugin, service } from '@arki/dot';

// Stand-ins for the pieces a real app brings.
type Logger = { info(message: string): void };
type Db = { query(sql: string): Promise<unknown[]> };
class BillingService {
  constructor(
    readonly db: Db,
    readonly log: Logger,
  ) {}
  async tick(): Promise<void> {
    this.log.info('tick');
    await this.db.query('select 1');
  }
}
const database = plugin({
  name: 'database',
  provides: { db: (): Db => ({ query: async () => [] }) },
});

export const billing = plugin({
  name: 'billing',
  needs: { db: database.provides.db, log: service<Logger>() },

  configure(ctx) {
    // Synchronous registration. No I/O.
    ctx.registerService('billing', 'custom');
  },
  provides: {
    // One factory per key. Publish services here.
    billing: ({ db, log }) => new BillingService(db, log),
  },
  async boot({ billing }) {
    // Side effects only (seed, warm-up). Returns nothing.
    await billing.tick();
  },
  async start({ billing }) {
    // Begin active work.
    await billing.tick();
  },
  async stop({ billing }) {
    // Halt active work.
    await billing.tick();
  },
  async dispose({ billing, db }) {
    // Release resources. Needs are still alive here (reverse-order teardown).
    await db.query(`close ${billing.constructor.name}`);
  },
});
```

Everything is inferred: the `needs` shape types the hook contexts, and the
`provides` factories become the plugin's provides — no generic arguments.
Returning a value from `boot` is a compile error.

## Fields

| Field       | Required | Meaning                                                                   |
| ----------- | -------- | ------------------------------------------------------------------------- |
| `name`      | yes      | Unique identifier inside an app.                                          |
| `needs`     | no       | Shape of service witnesses this plugin consumes (see below).              |
| `configure` | no       | Sync hook. Registers metadata. No I/O.                                    |
| `provides`  | no       | One factory per key. Gets the needs; may be async (awaited in key order). |
| `boot`      | no       | Async hook. Side effects only; sees needs and own provides.               |
| `start`     | no       | Async hook. Begins active work after every plugin has booted.             |
| `stop`      | no       | Async hook. Reverse order. Halts active work.                             |
| `dispose`   | no       | Async hook. Reverse order. Releases resources.                            |

## The five hooks (one-liner each)

1. **`configure`** — sync registration. Validate options, register routes,
   declare provided services for the manifest. No async, no I/O.
2. **`boot`** — async side effects. Seed, warm up, validate runtime config.
   Services come from the `provides` factories, which run first.
3. **`start`** — async activate. Workers, schedulers, subscribers.
4. **`stop`** — async halt. Drain workers, unsubscribe listeners.
5. **`dispose`** — async release. Close connections, free file handles.

The authoritative reference (state transitions, failure ordering,
idempotency) is [`lifecycle.md`](./lifecycle.md).

## Services and dependency injection

A plugin **provides** services through `provides`: one factory per key.
Factories get the plugin's needs (local aliases) plus `$app`, `$plugin` and
`$config`. They may be async. They run in key order and are awaited:

```ts run
import { defineApp, plugin } from '@arki/dot';

type Client = { ping(): Promise<void>; close(): Promise<void> };

// Stand-in for a real connection.
const openClient = async (): Promise<Client> => ({ ping: async () => {}, close: async () => {} });

export const apiClientPlugin = plugin({
  name: 'api-client',
  provides: {
    apiClient: (): Promise<Client> => openClient(),
  },
  async dispose({ apiClient }) {
    await apiClient.close();
  },
});
```

A plugin **consumes** services by declaring a `needs` shape. Name the
provider's handle when you can import it. The hook context delivers the
values fully typed — destructuring is the injection:

```ts continue
// Stand-in for the service this plugin publishes.
const makeBilling = (client: Client) => ({ charge: () => client.ping() });

export const billing = plugin({
  name: 'billing',
  needs: { apiClient: apiClientPlugin.provides.apiClient },
  provides: { billing: ({ apiClient }) => makeBilling(apiClient) },
  async boot({ apiClient }) {
    await apiClient.ping();
  },
});
```

`apiClientPlugin.provides.apiClient` is a `Handle<Client, 'apiClient'>`: a
token on the wire key, plus `.provider` (the plugin name) and `.lazy`.
Every plugin has these handles before boot. An app names the type with
`export type Db = Provided<typeof database.provides.db>`.

Use `service<T>()` only when you cannot import the provider: a library
contract, a test, or a host external.

`boot`, `start`, `stop` and `dispose` receive the needs plus the plugin's
own provided values.

Wiring is checked **at compile time**: `.use(billing)` is a type error
until an earlier `.use(...)` provides a compatible `apiClient`. The kernel
also checks every plugin's needs against every plugin's static provides at
`configure()`. A provider mounted after its consumer is
`ARKI_DOT_E020`. A ring through any plugins is `ARKI_DOT_E019`.
`ARKI_DOT_E012` (unsatisfied need at boot) is only for needs no plugin
declares (erased or JS graphs, dynamic http bundle tokens). `ARKI_DOT_E013`
(collision) and `ARKI_DOT_E014` (reserved key) cover erased/dynamic
composition.

Mounted in order, the wiring boots and the manifest records the need:

```ts continue
import { isFailure } from '@arki/failure';
const shop = await defineApp('shop').use(apiClientPlugin).use(billing).boot();
if (isFailure(shop)) throw new Error(shop.code);

const billingEntry = shop.manifest.plugins.find(p => p.name === 'billing');
if (billingEntry?.dependencies.join() !== 'apiClient') throw new Error('billing should need apiClient');
await shop.services.billing.charge();
await shop.dispose();
```

Hook contexts also carry `$`-prefixed kernel keys — `$app` (app name),
`$plugin` (plugin name), `$config` (the `defineApp(name, { config })` bag). The
`$` prefix is a reserved namespace: `plugin()` rejects `$`-prefixed needs
aliases and publish keys at compile time, and the kernel enforces the same
rule at runtime (`ARKI_DOT_E014`) for renames and erased plugins — so
kernel keys can never be shadowed.

## Declaration order is boot order

There is no dependency graph to declare. Providers are `.use()`d before
their consumers; the builder's type-level guard makes any other order a
compile error, and `stop`/`dispose` run in reverse. The manifest's
dependency edges are derived at `configure()` from static provides — one
labelled edge per capability, each carrying its `key`. `dot explain` prints
them without booting.

## Multi-instance: `rename`

Two plugins publishing the same wire key is a collision (compile error at
`.use()`, coded runtime error on erased paths). To mount a second
instance of an adapter, rename its published keys at the mount site:

```ts continue
import { rename } from '@arki/dot';

// Stand-in for an adapter factory such as `db()` from `@arki/db/dot`.
const db = (label: string) => plugin({ name: 'db', provides: { db: () => ({ label }) } });

const orders = await defineApp('orders')
  .use(db('primary'))
  .use(rename(db('reports'), { db: 'reportsDb' }, 'reports-db'))
  .boot();
if (isFailure(orders)) throw new Error(orders.code);

if (orders.services.db.label !== 'primary') throw new Error('primary instance lost');
if (orders.services.reportsDb.label !== 'reports') throw new Error('second instance missing'); // same type
await orders.dispose();
```

`rename` rebuilds the handles. Consumers of the second instance use
`reportsDb.provides.reportsDb`:

```ts continue
const reportsDb = rename(db('reports'), { db: 'reportsDb' }, 'reports-db');

export const reportReader = plugin({
  name: 'report-reader',
  needs: { db: reportsDb.provides.reportsDb },
  boot: ({ db }) => {
    if (db.label !== 'reports') throw new Error('wired to the wrong database');
  },
});
```

A handle taken before the rename keeps the old key and fails the builder guard.

A _feature_ mounted twice is `feature.instance(name, rebind)` — see the README,
"Two copies of a feature". The rebind takes any handle of the same service type:
`{ db: databaseEu.provides.dbEu }` binds the copy's `db` to the EU database
(another provider, another key); a child feature that needs the same handle
follows, lazy form included.

## Lazy services

When opening a resource is expensive and not every process needs it, wrap
the initialization in `lazy()` — `boot` stays cheap and the resource opens
on first use:

```ts continue
import { lazy } from '@arki/dot';

type SearchClient = { query(text: string): Promise<string[]>; close(): Promise<void> };

// Stand-in for an expensive connection.
const connectSearchCluster = async (): Promise<SearchClient> => ({
  query: async text => [text],
  close: async () => {},
});

export const searchPlugin = plugin({
  name: 'search',
  provides: {
    search: () =>
      lazy(() => connectSearchCluster(), {
        dispose: client => client.close(),
      }),
  },
  // no dispose hook needed — the kernel auto-disposes initialized handles
});
```

Laziness is visible in the type: the service is a `Lazy<SearchClient>`,
and consumers acquire it explicitly:

```ts continue
export const indexer = plugin({
  name: 'indexer',
  needs: { search: searchPlugin.provides.search },
  async boot({ search }) {
    const client = await search.get(); // first call initializes
    if (isFailure(client)) return client;
    await client.query('warm up');
    return;
  },
});
```

A handle to a lazy provider binds the consumer to a lazy provider. To stay
agnostic about the provider's strategy, ask for `service.lazy<T>()`. It
accepts an **eager or lazy** provider and always delivers a `Lazy<T>` (eager
values arrive pre-initialized):

```ts continue
import { service } from '@arki/dot';

export const agnosticIndexer = plugin({
  name: 'agnostic-indexer',
  needs: { search: service.lazy<SearchClient>() },
  async boot({ search }) {
    const client = await search.get();
    if (isFailure(client)) return client;
    await client.query('warm up');
    return;
  },
});

// Works against a lazy provider (passed through) ...
const lazyApp = await defineApp('lazy').use(searchPlugin).use(agnosticIndexer).start();
if (isFailure(lazyApp)) throw new Error(lazyApp.code);

// ... and against an eager one, whose value is lifted and arrives warm.
const eagerSearch = plugin({
  name: 'eager-search',
  provides: { search: async (): Promise<SearchClient> => connectSearchCluster() },
});
const eagerApp = await defineApp('eager').use(eagerSearch).use(agnosticIndexer).start();
if (isFailure(eagerApp)) throw new Error(eagerApp.code);

await lazyApp.dispose();
await eagerApp.dispose();
```

When the provider is in reach and publishes a plain value, its handle has the
same lift as `.lazy`: `needs: { search: eagerSearch.provides.search.lazy }`.
A handle of a provider that already publishes a `Lazy<T>` has the type
`Lazy<T>`, so `.lazy` on it would wrap a lazy in a lazy. Use `service.lazy<T>()`
there.

Semantics:

- `get()` is memoized and single-flight — concurrent callers share one
  initialization attempt; a **failed** attempt is not cached, so the next
  `get()` retries.
- A handle that is never `get()`ed never initializes — and its `dispose`
  callback never runs.
- The kernel auto-disposes initialized handles in reverse declaration
  order during `dispose()` and boot rollback, **after** the publishing
  plugin's own `dispose` hook (so the hook can still use the handle). No
  `dispose` hook is required for lazy-only plugins.
- `initialized` / `peek()` inspect without triggering initialization;
  `get()` after app disposal rejects.

## Cross-package contracts: tokens

`service<T>()` creates an _anonymous_ witness — the property name is the
wire key. When a contract is shared across packages, use a **token**: a
named witness whose owned key travels with it, so the local alias becomes
a free choice:

```ts continue
import { token } from '@arki/dot';

type KvClient = { get(key: string): Promise<string | undefined> };
const client: KvClient = { get: async key => key };

// @acme/kv owns the contract:
export const Kv = token<KvClient>()('acme.kv');

// provider (in @acme/kv):
export const kvPlugin = plugin({ name: 'kv', provides: { [Kv.key]: () => client } });

// any consumer, any alias:
export const cachePlugin = plugin({
  name: 'cache',
  needs: { cache: Kv }, // wire key 'acme.kv', local alias `cache`
  boot: async ({ cache }) => {
    await cache.get('warm'); // typed KvClient
  },
});

// derived instance token:
const SessionsKv = Kv.instance('sessions'); // key 'acme.kv#sessions'
if (SessionsKv.key !== 'acme.kv#sessions') throw new Error(`unexpected key ${SessionsKv.key}`);

const cacheApp = await defineApp('cache-demo').use(kvPlugin).use(cachePlugin).boot();
if (isFailure(cacheApp)) throw new Error(cacheApp.code);
await cacheApp.dispose();
```

## Manifest contribution

During `configure`, a plugin registers what it exposes:

```ts continue
export const invoicing = plugin({
  name: 'invoicing',
  configure(ctx) {
    ctx.registerService('billing', 'custom');
    ctx.registerAction({
      id: 'create-invoice',
      binding: 'http',
      direction: 'in',
      address: 'POST /invoices',
    });
    ctx.declareProvides('billing');
  },
});

const invoicingApp = defineApp('invoices').use(invoicing).configure();
if (invoicingApp.manifest.actions.map(a => a.id).join() !== 'create-invoice') throw new Error('action missing');
```

The merged result lands in `app.manifest`. Agents and CI tools read this
to understand what the app does without executing code.

Some text is only known after boot (which store a lock runs on). Complete an
action's `summary` with `ctx.$describeAction(id, { summary })` in `provides`,
`boot` or `start`, or `ctx.describeAction` in `configure`. A plugin may amend its
own actions, or actions in a binding it registered a projection for; anything
else throws `ARKI_DOT_E021`. `dot explain` stays static; the post-boot
manifest and `dot doctor` show the new text.

## Diagnostics

A plugin contributes runtime status to `app.diagnostics`. The kernel
automatically records lifecycle state. To emit a custom issue, throw a
structured error from a hook — the kernel wraps it into a
`DiagnosticIssue` with the plugin name attached.

```ts run expect
import { defineApp, DotPluginError, plugin } from '@arki/dot';
import { UnexpectedDefect } from '@arki/failure';

const strictBilling = plugin({
  name: 'strict-billing',
  async boot({ $config }) {
    const key = $config['BILLING_KEY'];
    if (!key) {
      throw new DotPluginError({
        code: 'BILLING_E001',
        message: 'BILLING_KEY not set',
        remediation: 'Set BILLING_KEY in your env or pass it to the billing plugin.',
        docsUrl: 'https://example.com/dot/docs/billing#config',
      });
    }
  },
});

const configured = defineApp('demo').use(strictBilling).configure();
const outcome = await configured.boot();
if (UnexpectedDefect.is(outcome) && outcome.cause instanceof DotPluginError) {
  console.log(outcome.code, outcome.cause.code);
  console.log(configured.diagnostics.issues.map(issue => `${issue.code} ${issue.plugin}`).join());
}
```

```text
failure.unexpected_defect BILLING_E001
ARKI_DOT_E003 strict-billing
```

The kernel records one issue under its own code (`ARKI_DOT_E003`, with the
plugin name and your message) and returns an `UnexpectedDefect` whose
`cause` is your `DotPluginError`. Your `code`, `remediation` and `docsUrl`
live on `cause`. See [Diagnostics](./diagnostics.md) for the full shape and
stable code conventions.

## Type-safe services

Provides are inferred from the `provides` factories and accumulate through the
builder:

```ts run
import { isFailure } from '@arki/failure';
import { defineApp, plugin } from '@arki/dot';

const a = plugin({ name: 'a', provides: { a: () => 1 } });
const b = plugin({ name: 'b', provides: { b: () => 'x' } });

const app = await defineApp('demo').use(a).use(b).boot();
if (isFailure(app)) throw new Error(app.code);
const first: number = app.services.a;
const second: string = app.services.b;
if (first !== 1 || second !== 'x') throw new Error('services lost their values');
await app.dispose();
```

The builder type narrows on every `.use(...)` call. No casts needed —
anywhere, including inside hooks.

## Testing with `fake`

`fake(handle, value)` from `@arki/dot/test-harness` is a plugin named
`fake:<key>`. It provides `value` under the handle's wire key, type-checked
against the handle:

```ts run
import { isFailure } from '@arki/failure';
import { defineApp, plugin } from '@arki/dot';
import { fake } from '@arki/dot/test-harness';

type Db = { query(sql: string): Promise<string> };
const database = plugin({ name: 'database', provides: { db: (): Db => ({ query: async () => 'real' }) } });
const reports = plugin({
  name: 'reports',
  needs: { db: database.provides.db },
  provides: { report: ({ db }) => db.query('select 1') },
});

const fakeDb: Db = { query: async () => 'fake' };
const app = await defineApp('t').use(fake(database.provides.db, fakeDb)).use(reports).boot();
if (isFailure(app)) throw new Error(app.code);
if (app.services.report !== 'fake') throw new Error('the fake did not replace the database');
await app.dispose();
```

## When NOT to write a plugin

If a module has nothing to do in `boot` — no connection to open, no
resource whose teardown must be ordered — it does not need to be a plugin.
Plain ES module exports already compose static values (routers, schemas,
factories) with perfect types. DOT's job is _runtime resources with
ordered setup and guaranteed reverse-order teardown_; keep static
composition in module space.

## Testing your plugin

`@arki/dot` ships a small test harness:

```ts
import { describe, expect, it } from 'vitest';

import { bootTestApp, plugin, testApp } from '@arki/dot';
import { isFailure } from '@arki/failure';

// The plugins under test, as ../src/billing-plugin.ts would export them.
type Client = { ping(): Promise<void> };
const apiClient = plugin({
  name: 'api-client',
  provides: { apiClient: (): Client => ({ ping: async () => {} }) },
});
const billing = plugin({
  name: 'billing',
  needs: { apiClient: apiClient.provides.apiClient },
  provides: { billing: ({ apiClient }) => ({ charge: () => apiClient.ping() }) },
});

describe('billing plugin', () => {
  it('publishes a billing service', async () => {
    const app = await bootTestApp([apiClient, billing]);
    if (isFailure(app)) throw new Error(app.code);
    expect(app.services.billing).toBeDefined();
    await app.dispose();
  });

  it('declares its needs in the manifest', () => {
    const configured = testApp([apiClient, billing]).configure();
    expect(configured.manifest.plugins.find(p => p.name === 'billing')?.dependencies).toEqual(['apiClient']);
  });
});
```

`testApp` returns a `DotAppBuilder` you can drive yourself; `bootTestApp`
boots immediately. Both honour the same lifecycle as production apps. Both
read `app.services` off the plugin tuple (`app.services.billing` above is
typed) and refuse a tuple that would not mount; a runtime-built array skips
that compile-time guard — the kernel's runtime validation still applies.

## Next steps

- [Lifecycle](./lifecycle.md) — hook contract, failure ordering, idempotency.
- [Diagnostics](./diagnostics.md) — manifest + diagnostics shapes.
- [Adapter authoring](./adapter-authoring.md) — expose your package as
  a DOT plugin.
