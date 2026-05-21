# Pip Authoring

A `DotPip` is a plain object with a name, optional dependencies, and up to
five lifecycle hooks. The kernel runs the hooks in dependency order
(`configure → boot → start`) and in reverse-dependency order for cleanup
(`stop → dispose`). See [Lifecycle](./lifecycle.md) for the full contract.

## Anatomy

```ts
import { defineDotPip } from '@arki/dot';

export const billing = defineDotPip({
  name: 'billing',
  version: '1.0.0',
  dependencies: ['env'],
  provides: ['billing'],

  configure(ctx) {
    // Synchronous registration. No I/O.
  },
  async boot(ctx) {
    // Open resources. Publish services.
    return { services: { /* ... */ } };
  },
  async start(ctx) {
    // Begin active work.
  },
  async stop(ctx) {
    // Halt active work.
  },
  async dispose(ctx) {
    // Release resources.
  },
});
```

`defineDotPip` is a typed identity function — it preserves the generic
`TServices` so downstream pips see fully typed `services` in their hook
contexts.

## Fields

| Field          | Required | Meaning                                                              |
| -------------- | -------- | -------------------------------------------------------------------- |
| `name`         | yes      | Unique identifier inside an app. Used in the dependency graph.       |
| `version`      | no       | Semver string. Surfaces in `PipManifest.version`.                 |
| `dependencies` | no       | Names of pips that must boot before this one.                     |
| `provides`     | no       | Capability strings — informational, surfaced in the manifest.        |
| `manifest`     | no       | Static or callback-form contribution (routes, services, edges).      |
| `configure`    | no       | Sync hook. Registers metadata. No I/O.                               |
| `boot`         | no       | Async hook. Opens resources, publishes services for DI.              |
| `start`        | no       | Async hook. Begins active work after every pip has booted.        |
| `stop`         | no       | Async hook. Reverse order. Halts active work.                        |
| `dispose`      | no       | Async hook. Reverse order. Releases resources.                       |

## The five hooks (one-liner each)

1. **`configure`** — sync registration. Validate options, register routes,
   declare provided services. No async, no I/O.
2. **`boot`** — async open. Connect clients, validate runtime config, return
   `{ services: { ... } }` for downstream pips to consume.
3. **`start`** — async activate. Workers, schedulers, subscribers.
4. **`stop`** — async halt. Drain workers, unsubscribe listeners.
5. **`dispose`** — async release. Close connections, free file handles.

The authoritative reference (state transitions, failure ordering,
idempotency) is [`lifecycle.md`](./lifecycle.md).

## Services and dependency injection

A pip publishes services by returning them from `boot`:

```ts
import { defineDotPip } from '@arki/dot';

type Client = { ping(): Promise<void>; close(): Promise<void> };

export const apiClient = defineDotPip<{ apiClient: Client }>({
  name: 'api-client',
  async boot() {
    const client: Client = await openClient();
    return { services: { apiClient: client } };
  },
  async dispose({ services }) {
    await services.apiClient.close();
  },
});
```

Downstream pips receive prior services through `ctx.services`:

```ts
import { defineDotPip } from '@arki/dot';

export const billing = defineDotPip({
  name: 'billing',
  dependencies: ['api-client'],
  async boot(ctx) {
    const client = ctx.services.get('apiClient');
    // ... use client to register billing routes
    return { services: {} };
  },
});
```

`ctx.services` is a `ReadonlyMap<string, unknown>` at the kernel level. Type
parameters on `defineDotPip<TServices>` carry the types forward at the app
boundary — `app.services.apiClient` is typed as `Client`.

## Manifest contribution

During `configure`, a pip registers what it exposes:

```ts
configure(ctx) {
  ctx.registerService('billing', 'custom');
  ctx.registerRoute({
    id: 'create-invoice',
    method: 'POST',
    path: '/invoices',
    transport: 'http',
  });
  ctx.registerLifecycleHook('boot');
  ctx.registerLifecycleHook('dispose');
  ctx.declareProvides('billing');
  ctx.declareDependency('api-client', 'requires');
}
```

The merged result lands in `app.manifest`. Agents and CI tools read this to
understand what the app does without executing code.

## Diagnostics

A pip contributes runtime status to `app.diagnostics`. The kernel
automatically records lifecycle state. To emit a custom issue, throw a
structured error from a hook — the kernel wraps it into a
`DiagnosticIssue` with the pip name attached.

```ts
async boot(ctx) {
  const config = ctx.config['BILLING_KEY'];
  if (!config) {
    throw Object.assign(new Error('BILLING_KEY not set'), {
      code: 'BILLING_E001',
      remediation: 'Set BILLING_KEY in your env or pass it to the billing pip.',
      docsUrl: 'https://example.com/dot/docs/billing#config',
    });
  }
  return { services: {} };
}
```

The properties `code`, `remediation`, and `docsUrl` propagate to the
`DiagnosticIssue` in `app.diagnostics.issues`. See
[Diagnostics](./diagnostics.md) for the full shape and stable code
conventions.

## Type-safe services

`defineDotPip<TServices>(pip)` carries the services type through to the
final `app.services` record:

```ts
const a = defineDotPip<{ a: number }>({ name: 'a', async boot() { return { services: { a: 1 } }; } });
const b = defineDotPip<{ b: string }>({ name: 'b', async boot() { return { services: { b: 'x' } }; } });

const app = await defineApp('demo').use(a).use(b).boot();
app.services.a; // number
app.services.b; // string
```

The builder type narrows on every `.use(...)` call. No casts needed.

## Testing your pip

`@arki/dot` ships a small test harness:

```ts
import { testApp, bootTestApp } from '@arki/dot';
import { describe, expect, it } from 'vitest';

import { billing } from '../src/billing-pip.js';

describe('billing pip', () => {
  it('publishes a billing service', async () => {
    const app = await bootTestApp([billing]);
    expect(app.services.billing).toBeDefined();
    await app.dispose();
  });

  it('declares a dependency on api-client', () => {
    const configured = testApp([billing]).configure();
    expect(configured.manifest.dependencies).toContainEqual({
      from: 'billing',
      to: 'api-client',
      kind: 'requires',
    });
  });
});
```

`testApp` returns a `DotAppBuilder` you can drive yourself; `bootTestApp`
boots immediately. Both honour the same lifecycle as production apps.

## Next steps

- [Lifecycle](./lifecycle.md) — hook contract, failure ordering, idempotency.
- [Diagnostics](./diagnostics.md) — manifest + diagnostics shapes.
- [Adapter authoring](./adapter-authoring.md) — package your pip as a
  reusable `./dot` subpath export.
