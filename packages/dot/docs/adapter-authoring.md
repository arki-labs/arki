# Adapter Authoring

A **DOT adapter** is a package-owned bridge between an arbitrary library
(database driver, queue client, mail provider) and the DOT kernel. Adapters
let users wire a package into a DOT app with a single import and a
single `.infra(...)` call.

This guide walks through the adapter pattern using the canonical
implementations in `@arki/env`, `@arki/kv`, and `@arki/db` as references.

## The adapter pattern

A package that wants DOT integration exposes a separate entry point at
the `./dot` subpath:

```
my-pkg/
├── src/
│   ├── index.ts     // public, framework-agnostic API
│   └── dot.ts       // DOT adapter
└── package.json
```

In `package.json`:

```json
{
  "name": "@acme/my-pkg",
  "exports": {
    ".": "./dist/index.js",
    "./dot": "./dist/dot.js"
  },
  "peerDependencies": {
    "@arki/dot": "^0.1.0"
  },
  "peerDependenciesMeta": {
    "@arki/dot": { "optional": true }
  }
}
```

`@arki/dot` is an **optional peer**. Importing `@acme/my-pkg/dot` without
`@arki/dot` installed will fail at module load — that's intentional: the
adapter only makes sense inside a DOT app.

## Function shape

An adapter exports a factory function with an inferred return type. Keep the
callbacks visible so Dot can infer their exact services and failures:

```ts run
import type { UnitProvides } from '@arki/dot/unit';
import { defineApp, infra } from '@arki/dot/unit';

// my-pkg/src/index.ts, the framework-agnostic client. A stand-in here.
class MyClient {
  constructor(
    readonly url: string,
    readonly options: { readonly timeoutMs?: number } = {},
  ) {}
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
}

// my-pkg/src/dot.ts

export type MyPkgDotOptions = {
  readonly url: string;
};

export type MyPkgServices = UnitProvides<ReturnType<typeof myPkg>>;

export function myPkg(options: MyPkgDotOptions) {
  return infra({
    name: 'my-pkg',

    configure(ctx) {
      ctx.registerService('myClient', 'custom');
    },

    provides: {
      myClient: async () => {
        const myClient = new MyClient(options.url);
        await myClient.connect();
        return myClient;
      },
    },

    async dispose({ myClient }) {
      await myClient.close();
    },
  });
}
```

**Convention:** the exported factory is named after the package
(`env`, `kv`, `db`, `queue`, ...). Users see the same call, here with the
factory above in scope:

```ts continue
import { isFailure } from '@arki/failure';

const app = await defineApp('billing')
  .infra(myPkg({ url: 'memory://primary' }))
  .boot();
if (isFailure(app)) throw new Error(app.code);

if (!(app.services.myClient instanceof MyClient)) throw new Error('myClient was not published');
await app.dispose();
```

Do NOT take a `name` option for multi-instance mounting — that's the app
author's job via `rename`:

```ts continue
import { rename } from '@arki/dot/unit';

const twoClients = await defineApp('billing')
  .infra(myPkg({ url: 'memory://primary' }))
  .infra(rename(myPkg({ url: 'memory://replica' }), { myClient: 'replicaClient' }, 'my-pkg-replica'))
  .boot();
if (isFailure(twoClients)) throw new Error(twoClients.code);

if (twoClients.services.replicaClient.url !== 'memory://replica') throw new Error('rename did not retarget the key');
await twoClients.dispose();
```

## Service registration in `configure`

`configure` is **sync** and runs before any I/O. Use it to declare
metadata only:

```ts continue
// For well-known kinds: 'env' | 'db' | 'kv' | 'queue' | 'auth' | 'email' | 'logger'
export const registersOnly = infra({
  name: 'my-pkg-registers',
  configure(ctx) {
    ctx.registerService('myClient', 'custom');
  },
});
```

The kernel merges every unit's registration into `app.manifest`. Agents
read this to know what services exist before the app boots.

## Resource opening in `provides`

A unit publishes through `provides`: one factory per key. Factories may be
async. Open exactly one resource per factory. `boot` performs side effects and
returns `undefined`, a concrete refusal or a private ownership plan:

```ts continue
export const withTimeout = infra({
  name: 'my-pkg-timeout',
  provides: {
    myClient: async ({ $config }) => {
      // Optional: read config injected by `defineApp(name, { config })`.
      const configured = $config['MY_PKG_TIMEOUT_MS'];
      const timeoutMs = typeof configured === 'number' ? configured : 5000;

      const myClient = new MyClient('memory://', { timeoutMs });
      await myClient.connect();
      return myClient;
    },
  },
});
```

Because the keys are static, consumers get typed handles before boot:
`myPkgInfra.provides.myClient`. Read config that may change late (a URL from
env) through a thunk option, called inside the factory, as `@arki/db/dot` does
with `url: () => env.DB_URL`.

If a factory opens multiple resources and one of them fails, clean up the
partial state yourself before throwing — the kernel only disposes units
whose factories completed.

```ts continue
// Stand-ins for two resources the adapter opens together.
const openA = async () => ({ close: async () => {} });
const openB = async () => ({ close: async () => {} });

export const pairInfra = infra({
  name: 'my-pkg-pair',
  provides: {
    pair: async () => {
      const a = await openA();
      try {
        const b = await openB();
        return { a, b };
      } catch (err) {
        await a.close();
        throw err;
      }
    },
  },
});
```

## Consuming other services

If your adapter needs a service from another unit (say, a logger), declare
it in `needs` — the hook context delivers it typed, and the app builder
refuses composition orders that can't satisfy it:

```ts continue
import { service } from '@arki/dot/unit';

// Stand-in for the logger contract another unit provides.
type Logger = { info(message: string): void };

export const needsLogger = infra({
  name: 'my-pkg-logged',
  needs: { log: service<Logger>() },
  boot: ({ log }) => {
    log.info('my-pkg booting');
  },
  provides: { myClient: () => new MyClient('memory://') },
});
```

## Cleanup in `dispose`

`dispose` runs in reverse declaration order — your `needs` are still alive
when it runs. The context carries your own published services plus your
needs:

```ts continue
export const closesClient = infra({
  name: 'my-pkg-closes',
  provides: { myClient: () => new MyClient('memory://') },
  async dispose({ myClient }) {
    await myClient.close();
  },
});
```

`stop` runs first if the unit has active work (workers, subscribers).
`dispose` runs even if `stop` failed — the kernel collects per-unit
failures into an aggregate `DotLifecycleError`.

## Manifest contribution beyond services

For adapters that expose app-boundary interactions, declare **actions**.
Actions are transport-neutral: HTTP routes, queue consumers/producers, CLI
commands, cron ticks, and future bindings all share the same kernel shape.

```ts continue
export const declaresAction = infra({
  name: 'my-pkg-actions',
  configure(ctx) {
    ctx.registerService('myClient', 'custom');
    ctx.registerAction({
      id: 'health',
      binding: 'http',
      direction: 'in',
      address: 'GET /_health/my-pkg',
      summary: 'Adapter health check',
      metaSchema: '@acme/my-pkg/action-meta@1',
      meta: {
        method: 'GET',
        path: '/_health/my-pkg',
      },
    });
  },
});
```

`binding` is an open string. Well-known bindings include `http`, `queue`,
`cli`, `cron`, `orpc`, and `trpc`; third-party bindings should be
package-qualified, for example `acme:bus`. Keep machine-readable adapter
detail in `meta`, and version that layout with `metaSchema`.

Adapters can also provide projections for `dot explain --as <format>`:

```ts continue
export const declaresProjection = infra({
  name: 'my-pkg-projection',
  configure(ctx) {
    ctx.registerProjection({
      format: 'openapi',
      binding: 'http',
      module: '@acme/my-pkg/projection',
    });
  },
});
```

Projection modules export `project(manifest)`. They must be pure and return
JSON-round-trip-safe output. Package subpath exports for projection modules
must include a `default` condition so the CLI's Node fallback can resolve
them app-relative.

Dependency edges are not declared — the kernel derives them at `configure()`
from every unit's needs and static provides, and writes them into
`app.manifest.dependencies` (each entry carries its `key`). Manifest
`provides` is filled at configure for adapters too. A provider mounted after
its consumer is `ARKI_DOT_E020`.

## Feature slices

Apps organize by **feature units**: one unit per feature, its contributions
published under a single token whose value is a plain object of
adapter-owned **slice keys**. Activator units (an HTTP server, a queue
runtime, a scheduler) accept `features:` token lists and read only their
own key — structurally, with no shared type between adapters.

Well-known slice keys, each owned by the adapter that consumes it:

| Key         | Value                                                                 | Consuming activator |
| ----------- | --------------------------------------------------------------------- | ------------------- |
| `routes`    | an HTTP route bundle (bindings + derivers + rpc mounts)               | `@arki/http`        |
| `queue`     | a queue definition registry (jobs, queue-schedules, flows)            | `@arki/queue`       |
| `schedules` | in-process schedule definitions                                       | `@arki/schedule`    |
| `journal`   | a journal bundle (projections + effects, from `journalHandlers(...)`) | `@arki/journal`     |

Third-party adapters MUST package-qualify their slice keys (`'acme:bus'`)
— the same namespacing rule as bindings.

Rules an adapter's `features:` option must follow:

- **Partial tokens are accepted by design.** A feature with no slice for
  your adapter contributes nothing; emit a **debug log** for the empty
  contribution so wiring mistakes surface at boot. "Wrong token rejected
  at the activator" is deliberately NOT a property of the protocol —
  type safety lives at the feature's provide site.
- **Do not declare actions for feature-contributed work.** The feature
  declares its own actions (contracts, `queueActions(...)`,
  `scheduleActions(...)`, rpc-mount defs) so manifest attribution stays
  with the feature. Duplicate `(binding, id)` pairs are the kernel's
  E016 backstop if both sides ever declare.
- **A missing token key at boot is a coded error** (erased composition
  only — the typed builder catches it at the mount call).
- **Resolve feature-derived context/config ONCE inside your guarded
  start**, never per execution: assembly failure must degrade boot, not
  every later dispatch.
- **Qualify what you register by the feature's instance.** A feature
  mounted twice (`reports.instance('eu')`) is two features named `reports#eu`
  and `reports#us` with the SAME slice objects. Where you read the slice, read
  `instanceOf(f.name)` (`@arki/dot/feature`; `'eu'`, or `undefined` for a plain
  feature) and register names as `` `${name}#${instance}` `` (schedules, jobs,
  effects) or under a `/${instance}` path (routes). A plain feature's names
  must stay byte-identical — they are persisted (lock hashes, queue names,
  job rows).

## Diagnostics — stable codes and remediation

Return a canonical failure from an owned provider or boot hook. Its code and remediation come from one definition; the app's result infers that definition.

```ts run expect
import { defineApp, infra } from '@arki/dot/unit';
import { defineFailure } from '@arki/failure';

const UrlRequired = defineFailure('strict_pkg.url_required', {
  remediation: 'Pass options.url to strictPkg(...) or set MY_PKG_URL.',
});
export function strictPkg(options: { readonly url?: string }) {
  return infra({
    name: 'strict-pkg',
    boot() {
      if (!options.url) return UrlRequired();
      return;
    },
  });
}
const result = await defineApp('billing').infra(strictPkg({})).boot();
if (UrlRequired.is(result)) console.log(result.code, result.remediation);
```

```text
strict_pkg.url_required Pass options.url to strictPkg(...) or set MY_PKG_URL.
```

Legacy thrown `DotUnitError` values remain private causes of `UnexpectedDefect`. Stable `ARKI_DOT_E*` diagnostics still identify the failing phase and owner; match the returned canonical failure to handle an expected refusal.

## Testing your adapter

Use `@arki/dot`'s test harness:

```ts
import { describe, expect, it } from 'vitest';

import { bootTestApp, DotUnitError, infra } from '@arki/dot';
import { orThrow } from '@arki/failure';

// The adapter under test, as src/dot.ts would export it.
function strictPkg(options: { readonly url?: string }) {
  return infra({
    name: 'strict-pkg',
    boot() {
      if (!options.url) {
        throw new DotUnitError({
          code: 'MY_PKG_E001',
          message: '[strict-pkg] url is required',
          remediation: 'Pass options.url to strictPkg(...).',
          docsUrl: 'https://example.com/my-pkg/docs#configuration',
        });
      }
    },
  });
}

describe('strictPkg adapter', () => {
  it('mounts and disposes with a url', async () => {
    const app = orThrow(await bootTestApp([strictPkg({ url: 'memory://' })]));
    expect(app.manifest.plugins.map(p => p.name)).toEqual(['strict-pkg']);
    await app.dispose();
  });

  it('fails boot with the adapter code in cause when url is missing', async () => {
    const booting = bootTestApp([strictPkg({})]);
    await expect(booting).rejects.toMatchObject({
      code: 'ARKI_DOT_E003',
      cause: { code: 'MY_PKG_E001' },
    });
  });
});
```

For adapters that need a server (e.g., a Redis instance), prefer a
hermetic embedded driver (in-memory mode, PGlite, etc.) for unit tests and
gate integration tests behind a feature flag.

## peerDependency on `@arki/dot`

Adapters declare `@arki/dot` as an **optional peer** so that:

- Users who don't use DOT don't install the kernel.
- Users who do use DOT install a single version of `@arki/dot` across the
  app — the adapter doesn't pin its own copy.

```json
{
  "peerDependencies": {
    "@arki/dot": "^0.1.0"
  },
  "peerDependenciesMeta": {
    "@arki/dot": { "optional": true }
  }
}
```

Import the kernel from `@arki/dot/unit` (a narrow entry that exports
`unit`, `service`, `token`, `rename`, and the unit types — no CLI).
This minimises what the adapter pulls in.

## Canonical examples

See the official adapters for reference:

- `@arki/dot/env` — env validation via Zod (sync provides, no cleanup).
- `@arki/kv/dot` — Redis-backed KV (async provides, dispose closes the client).
- `@arki/db/dot` — Drizzle ORM (async provides, dispose closes the pool).

Each of these is fewer than 100 lines and demonstrates a different
combination of the hooks.

## Helpers for adapter code

- `ownUnits(feature)` (from `@arki/dot/feature`) returns the units that belong to one feature node only, never those of its nested features.
- `requestServices(features)` (from `@arki/dot/feature`) returns the `provides` a gateway needs to serve requests for those features: their public handles and the `<name>.services` bag of every node.
- `toJsonObject(value)` (from `@arki/dot`) checks that manifest metadata survives a JSON round trip. It throws `DotManifestError` for dates, functions, `NaN` and cycles.

## See also

- [Unit authoring](./unit-authoring.md) — the general `Unit`
  contract.
- [Lifecycle](./lifecycle.md) — hook ordering and failure semantics.
- [Diagnostics](./diagnostics.md) — emitting actionable issues.
- [Release policy](./release-policy.md) — versioning your adapter against
  `@arki/dot`.
