# Pip Authoring

A pip is authored with `pip(config)` — a name, an optional `needs` shape,
and up to five lifecycle hooks. The kernel runs the hooks in declaration
order (`configure → boot → start`) and in reverse declaration order for
cleanup (`stop → dispose`). See [Lifecycle](./lifecycle.md) for the full
contract.

## Anatomy

```ts
import { pip, service } from '@arki/dot';

export const billing = pip({
  name: 'billing',
  version: '1.0.0',
  needs: { db: service<Db>(), log: service<Logger>() },

  configure(ctx) {
    // Synchronous registration. No I/O.
  },
  async boot({ db, log }) {
    // Open resources. Publish services by returning them.
    return { billing: new BillingService(db, log) };
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
`boot` return type becomes the pip's provides — no generic arguments.

## Fields

| Field       | Required | Meaning                                                              |
| ----------- | -------- | -------------------------------------------------------------------- |
| `name`      | yes      | Unique identifier inside an app.                                     |
| `version`   | no       | Semver string. Surfaces in `PipManifest.version`.                    |
| `needs`     | no       | Shape of service witnesses this pip consumes (see below).            |
| `configure` | no       | Sync hook. Registers metadata. No I/O.                               |
| `boot`      | no       | Async hook. Opens resources; its return value IS the provides.       |
| `start`     | no       | Async hook. Begins active work after every pip has booted.           |
| `stop`      | no       | Async hook. Reverse order. Halts active work.                        |
| `dispose`   | no       | Async hook. Reverse order. Releases resources.                       |

## The five hooks (one-liner each)

1. **`configure`** — sync registration. Validate options, register routes,
   declare provided services for the manifest. No async, no I/O.
2. **`boot`** — async open. Connect clients, validate runtime config, return
   a record of services for downstream pips to consume.
3. **`start`** — async activate. Workers, schedulers, subscribers.
4. **`stop`** — async halt. Drain workers, unsubscribe listeners.
5. **`dispose`** — async release. Close connections, free file handles.

The authoritative reference (state transitions, failure ordering,
idempotency) is [`lifecycle.md`](./lifecycle.md).

## Services and dependency injection

A pip **provides** services by returning them from `boot`:

```ts
import { pip } from '@arki/dot';

type Client = { ping(): Promise<void>; close(): Promise<void> };

export const apiClient = pip({
  name: 'api-client',
  async boot() {
    const client: Client = await openClient();
    return { apiClient: client };
  },
  async dispose({ apiClient }) {
    await apiClient.close();
  },
});
```

A pip **consumes** services by declaring a `needs` shape of type
witnesses. The hook context delivers them fully typed — destructuring is
the injection:

```ts
import { pip, service } from '@arki/dot';

export const billing = pip({
  name: 'billing',
  needs: { apiClient: service<Client>() },
  async boot({ apiClient }) {
    await apiClient.ping();
    return { billing: makeBilling(apiClient) };
  },
});
```

Wiring is checked **at compile time**: `.use(billing)` is a type error
until an earlier `.use(...)` provides a compatible `apiClient`. The kernel
re-validates at runtime (coded errors `DOT_LIFECYCLE_E012` unsatisfied
need, `DOT_LIFECYCLE_E013` collision, `DOT_LIFECYCLE_E014` reserved key)
for erased/dynamic composition.

Hook contexts also carry `$`-prefixed kernel keys — `$app` (app name),
`$pip` (pip name), `$config` (the `defineApp(name, { config })` bag). The
`$` prefix is a reserved namespace: `pip()` rejects `$`-prefixed needs
aliases and publish keys at compile time, and the kernel enforces the same
rule at runtime (`DOT_LIFECYCLE_E014`) for renames and erased pips — so
kernel keys can never be shadowed.

## Declaration order is boot order

There is no dependency graph to declare. Providers are `.use()`d before
their consumers; the builder's type-level guard makes any other order a
compile error, and `stop`/`dispose` run in reverse. The manifest's
dependency edges are *observed* from actual wiring at boot — which pip's
service satisfied which need.

## Multi-instance: `rename`

Two pips publishing the same wire key is a collision (compile error at
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

## Lazy services

When opening a resource is expensive and not every process needs it, wrap
the initialization in `lazy()` — `boot` stays cheap and the resource opens
on first use:

```ts
import { lazy, pip } from '@arki/dot';

export const search = pip({
  name: 'search',
  boot: () => ({
    search: lazy(() => connectSearchCluster(), {
      dispose: client => client.close(),
    }),
  }),
  // no dispose hook needed — the kernel auto-disposes initialized handles
});
```

Laziness is visible in the type: the service is a `Lazy<SearchClient>`,
and consumers acquire it explicitly:

```ts
export const indexer = pip({
  name: 'indexer',
  needs: { search: service<Lazy<SearchClient>>() },
  async start({ search }) {
    const client = await search.get();   // first call initializes
    // ...
  },
});
```

`service<Lazy<T>>()` binds the consumer to a lazy provider. To stay
agnostic about the provider's strategy, use the lifting witness
`service.lazy<T>()` — it accepts an **eager or lazy** provider and always
delivers a `Lazy<T>` handle (eager values arrive pre-initialized):

```ts
needs: { search: service.lazy<SearchClient>() },
// works against boot: () => ({ search: client })          (lifted, warm)
// and     boot: () => ({ search: lazy(() => connect()) }) (passed through)
```

Semantics:

- `get()` is memoized and single-flight — concurrent callers share one
  initialization attempt; a **failed** attempt is not cached, so the next
  `get()` retries.
- A handle that is never `get()`ed never initializes — and its `dispose`
  callback never runs.
- The kernel auto-disposes initialized handles in reverse declaration
  order during `dispose()` and boot rollback, **after** the publishing
  pip's own `dispose` hook (so the hook can still use the handle). No
  `dispose` hook is required for lazy-only pips.
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
pip({ name: 'kv', boot: () => provide(Kv, client) });

// any consumer, any alias:
pip({
  name: 'cache',
  needs: { cache: Kv },       // wire key 'acme.kv', local alias `cache`
  async boot({ cache }) { /* typed KvClient */ },
});

// derived instance token:
const SessionsKv = Kv.instance('sessions'); // key 'acme.kv#sessions'
```

## Manifest contribution

During `configure`, a pip registers what it exposes:

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

## Diagnostics

A pip contributes runtime status to `app.diagnostics`. The kernel
automatically records lifecycle state. To emit a custom issue, throw a
structured error from a hook — the kernel wraps it into a
`DiagnosticIssue` with the pip name attached.

```ts
async boot({ $config }) {
  const key = $config['BILLING_KEY'];
  if (!key) {
    throw Object.assign(new Error('BILLING_KEY not set'), {
      code: 'BILLING_E001',
      remediation: 'Set BILLING_KEY in your env or pass it to the billing pip.',
      docsUrl: 'https://example.com/dot/docs/billing#config',
    });
  }
  return {};
}
```

The properties `code`, `remediation`, and `docsUrl` propagate to the
`DiagnosticIssue` in `app.diagnostics.issues`. See
[Diagnostics](./diagnostics.md) for the full shape and stable code
conventions.

## Type-safe services

Provides are inferred from `boot` return types and accumulate through the
builder:

```ts
const a = pip({ name: 'a', boot: () => ({ a: 1 }) });
const b = pip({ name: 'b', boot: () => ({ b: 'x' }) });

const app = await defineApp('demo').use(a).use(b).boot();
app.services.a; // number
app.services.b; // string
```

The builder type narrows on every `.use(...)` call. No casts needed —
anywhere, including inside hooks.

## When NOT to write a pip

If a module has nothing to do in `boot` — no connection to open, no
resource whose teardown must be ordered — it does not need to be a pip.
Plain ES module exports already compose static values (routers, schemas,
factories) with perfect types. DOT's job is *runtime resources with
ordered setup and guaranteed reverse-order teardown*; keep static
composition in module space.

## Testing your pip

`@arki/dot` ships a small test harness:

```ts
import { testApp, bootTestApp } from '@arki/dot';
import { describe, expect, it } from 'vitest';

import { billing } from '../src/billing-pip.js';

describe('billing pip', () => {
  it('publishes a billing service', async () => {
    const app = await bootTestApp([apiClient, billing]);
    expect(app.services.billing).toBeDefined();
    await app.dispose();
  });

  it('declares its needs in the manifest', () => {
    const configured = testApp([apiClient, billing]).configure();
    expect(configured.manifest.pips.find(p => p.name === 'billing')?.dependencies).toEqual(['apiClient']);
  });
});
```

`testApp` returns a `DotAppBuilder` you can drive yourself; `bootTestApp`
boots immediately. Both honour the same lifecycle as production apps.
Note: `testApp` takes an erased pip array, so the compile-time guard does
not apply — the kernel's runtime validation still does.

## Next steps

- [Lifecycle](./lifecycle.md) — hook contract, failure ordering, idempotency.
- [Diagnostics](./diagnostics.md) — manifest + diagnostics shapes.
- [Adapter authoring](./adapter-authoring.md) — expose your package as
  a DOT pip.
