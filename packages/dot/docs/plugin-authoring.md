# Plugin Authoring

A plugin is authored with `plugin(config)` — a name, an optional `needs` shape,
and up to five lifecycle hooks. The kernel runs the hooks in declaration
order (`configure → boot → start`) and in reverse declaration order for
cleanup (`stop → dispose`). See [Lifecycle](./lifecycle.md) for the full
contract.

## Anatomy

```ts
import { plugin, service } from '@arki/dot';

export const billing = plugin({
  name: 'billing',
  version: '1.0.0',
  needs: { db: database.provides.db, log: service<Logger>() },

  configure(ctx) {
    // Synchronous registration. No I/O.
  },
  provides: {
    // One factory per key. Publish services here.
    billing: ({ db, log }) => new BillingService(db, log),
  },
  async boot({ billing }) {
    // Side effects only (seed, warm-up). Returns nothing.
  },
  async start({ billing }) {
    // Begin active work.
  },
  async stop({ billing }) {
    // Halt active work.
  },
  async dispose({ billing, db }) {
    // Release resources. Needs are still alive here (reverse-order teardown).
  },
});
```

Everything is inferred: the `needs` shape types the hook contexts, and the
`provides` factories become the plugin's provides — no generic arguments.
Returning a value from `boot` is a compile error.

## Fields

| Field       | Required | Meaning                                                              |
| ----------- | -------- | -------------------------------------------------------------------- |
| `name`      | yes      | Unique identifier inside an app.                                     |
| `version`   | no       | Semver string. Surfaces in `PluginManifest.version`.                    |
| `needs`     | no       | Shape of service witnesses this plugin consumes (see below).            |
| `configure` | no       | Sync hook. Registers metadata. No I/O.                               |
| `provides`  | no       | One factory per key. Gets the needs; may be async (awaited in key order). |
| `boot`      | no       | Async hook. Side effects only; sees needs and own provides.          |
| `start`     | no       | Async hook. Begins active work after every plugin has booted.           |
| `stop`      | no       | Async hook. Reverse order. Halts active work.                        |
| `dispose`   | no       | Async hook. Reverse order. Releases resources.                       |

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

```ts
import { plugin } from '@arki/dot';

type Client = { ping(): Promise<void>; close(): Promise<void> };

export const apiClient = plugin({
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

```ts
import { plugin } from '@arki/dot';

export const billing = plugin({
  name: 'billing',
  needs: { apiClient: apiClientPlugin.provides.apiClient },
  async boot({ apiClient }) {
    await apiClient.ping();
  },
  provides: { billing: ({ apiClient }) => makeBilling(apiClient) },
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
`DOT_LIFECYCLE_E020`. A ring through any plugins is `DOT_LIFECYCLE_E019`.
`DOT_LIFECYCLE_E012` (unsatisfied need at boot) is only for needs no plugin
declares (erased or JS graphs, dynamic http bundle tokens). `DOT_LIFECYCLE_E013`
(collision) and `DOT_LIFECYCLE_E014` (reserved key) cover erased/dynamic
composition.

Hook contexts also carry `$`-prefixed kernel keys — `$app` (app name),
`$plugin` (plugin name), `$config` (the `defineApp(name, { config })` bag). The
`$` prefix is a reserved namespace: `plugin()` rejects `$`-prefixed needs
aliases and publish keys at compile time, and the kernel enforces the same
rule at runtime (`DOT_LIFECYCLE_E014`) for renames and erased plugins — so
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

```ts
import { defineApp, rename } from '@arki/dot';
import { db } from '@arki/db/dot';

const app = await defineApp('orders')
  .use(db({ relations }))
  .use(rename(db({ driver: 'pglite', memory: true, relations }), { db: 'reportsDb' }, 'reports-db'))
  .boot();

app.services.db;        // primary
app.services.reportsDb; // second instance, same type
```

`rename` rebuilds the handles. Consumers of the second instance use
`reportsDb.provides.reportsDb`:

```ts
const reportsDb = rename(db({ driver: 'pglite', memory: true, relations }), { db: 'reportsDb' }, 'reports-db');
// needs: { db: reportsDb.provides.reportsDb }
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

```ts
import { lazy, plugin } from '@arki/dot';

export const search = plugin({
  name: 'search',
  provides: {
    search: () => lazy(() => connectSearchCluster(), {
      dispose: client => client.close(),
    }),
  },
  // no dispose hook needed — the kernel auto-disposes initialized handles
});
```

Laziness is visible in the type: the service is a `Lazy<SearchClient>`,
and consumers acquire it explicitly:

```ts
export const indexer = plugin({
  name: 'indexer',
  needs: { search: searchPlugin.provides.search },
  async start({ search }) {
    const client = await search.get();   // first call initializes
    // ...
  },
});
```

A handle to a lazy provider binds the consumer to a lazy provider. To stay
agnostic about the provider's strategy, use `.lazy` on the handle — it
accepts an **eager or lazy** provider and always delivers a `Lazy<T>`
(eager values arrive pre-initialized):

```ts
needs: { search: searchPlugin.provides.search.lazy },
// works against provides: { search: () => client }                (lifted, warm)
// and           provides: { search: () => lazy(() => connect()) } (passed through)
```

Without the provider in reach, `service.lazy<T>()` does the same job.

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

`service<T>()` creates an *anonymous* witness — the property name is the
wire key. When a contract is shared across packages, use a **token**: a
named witness whose owned key travels with it, so the local alias becomes
a free choice:

```ts
// @acme/kv owns the contract:
export const Kv = token<KvClient>()('acme.kv');

// provider (in @acme/kv):
plugin({ name: 'kv', provides: { [Kv.key]: () => client } });

// any consumer, any alias:
plugin({
  name: 'cache',
  needs: { cache: Kv },       // wire key 'acme.kv', local alias `cache`
  boot: ({ cache }) => { /* typed KvClient */ },
});

// derived instance token:
const SessionsKv = Kv.instance('sessions'); // key 'acme.kv#sessions'
```

## Manifest contribution

During `configure`, a plugin registers what it exposes:

```ts
configure(ctx) {
  ctx.registerService('billing', 'custom');
  ctx.registerAction({
    id: 'create-invoice',
    binding: 'http',
    direction: 'in',
    address: 'POST /invoices',
  });
  ctx.declareProvides('billing');
}
```

The merged result lands in `app.manifest`. Agents and CI tools read this
to understand what the app does without executing code.

Some text is only known after boot (which store a lock runs on). Complete an
action's `summary` with `ctx.$describeAction(id, { summary })` in `provides`,
`boot` or `start`, or `ctx.describeAction` in `configure`. A plugin may amend its
own actions, or actions in a binding it registered a projection for; anything
else throws `DOT_LIFECYCLE_E021`. `dot explain` stays static; the post-boot
manifest and `dot doctor` show the new text.

## Diagnostics

A plugin contributes runtime status to `app.diagnostics`. The kernel
automatically records lifecycle state. To emit a custom issue, throw a
structured error from a hook — the kernel wraps it into a
`DiagnosticIssue` with the plugin name attached.

```ts
async boot({ $config }) {
  const key = $config['BILLING_KEY'];
  if (!key) {
    throw Object.assign(new Error('BILLING_KEY not set'), {
      code: 'BILLING_E001',
      remediation: 'Set BILLING_KEY in your env or pass it to the billing plugin.',
      docsUrl: 'https://example.com/dot/docs/billing#config',
    });
  }
}
```

The properties `code`, `remediation`, and `docsUrl` propagate to the
`DiagnosticIssue` in `app.diagnostics.issues`. See
[Diagnostics](./diagnostics.md) for the full shape and stable code
conventions.

## Type-safe services

Provides are inferred from the `provides` factories and accumulate through the
builder:

```ts
const a = plugin({ name: 'a', provides: { a: () => 1 } });
const b = plugin({ name: 'b', provides: { b: () => 'x' } });

const app = await defineApp('demo').use(a).use(b).boot();
app.services.a; // number
app.services.b; // string
```

The builder type narrows on every `.use(...)` call. No casts needed —
anywhere, including inside hooks.

## Testing with `fake`

`fake(handle, value)` from `@arki/dot/test-harness` is a plugin named
`fake:<key>`. It provides `value` under the handle's wire key, type-checked
against the handle:

```ts
import { fake } from '@arki/dot/test-harness';

defineApp('t').use(fake(database.provides.db, db)).features([billing]);
```

## When NOT to write a plugin

If a module has nothing to do in `boot` — no connection to open, no
resource whose teardown must be ordered — it does not need to be a plugin.
Plain ES module exports already compose static values (routers, schemas,
factories) with perfect types. DOT's job is *runtime resources with
ordered setup and guaranteed reverse-order teardown*; keep static
composition in module space.

## Testing your plugin

`@arki/dot` ships a small test harness:

```ts
import { testApp, bootTestApp } from '@arki/dot';
import { describe, expect, it } from 'vitest';

import { billing } from '../src/billing-plugin.js';

describe('billing plugin', () => {
  it('publishes a billing service', async () => {
    const app = await bootTestApp([apiClient, billing]);
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
