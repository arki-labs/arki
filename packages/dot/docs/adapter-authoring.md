# Adapter Authoring

A **DOT adapter** is a package-owned bridge between an arbitrary library
(database driver, queue client, mail provider) and the DOT kernel. Adapters
let users wire a package into a DOT app with a single import and a
single `.use(...)` call.

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

An adapter exports a factory function that returns a `Pip`:

```ts
// my-pkg/src/dot.ts
import { pip, type EmptyShape, type Pip } from '@arki/dot/pip';

import { MyClient } from './index.js';

export type MyPkgDotOptions = {
  readonly url: string;
};

export type MyPkgServices = {
  readonly myClient: MyClient;
};

export function myPkg(options: MyPkgDotOptions): Pip<EmptyShape, MyPkgServices> {
  return pip({
    name: 'my-pkg',
    version: '1.0.0',

    configure(ctx) {
      ctx.registerService('myClient', 'custom');
    },

    async boot(): Promise<MyPkgServices> {
      const myClient = new MyClient(options.url);
      await myClient.connect();
      return { myClient };
    },

    async dispose({ myClient }) {
      await myClient.close();
    },
  });
}
```

**Convention:** the exported factory is named after the package
(`env`, `kv`, `db`, `queue`, ...). Users see:

```ts
import { myPkg } from '@acme/my-pkg/dot';

const app = await defineApp('billing').use(myPkg({ url: '...' })).boot();
```

Do NOT take a `name` option for multi-instance mounting — that's the app
author's job via `rename`:

```ts
import { rename } from '@arki/dot';

.use(myPkg({ url: primaryUrl }))
.use(rename(myPkg({ url: replicaUrl }), { myClient: 'replicaClient' }, 'my-pkg-replica'))
```

## Service registration in `configure`

`configure` is **sync** and runs before any I/O. Use it to declare
metadata only:

```ts
configure(ctx) {
  ctx.registerService('myClient', 'custom');
  // For well-known kinds: 'env' | 'db' | 'kv' | 'queue' | 'auth' | 'email' | 'logger'
}
```

The kernel merges every pip's registration into `app.manifest`. Agents
read this to know what services exist before the app boots.

## Resource opening in `boot`

`boot` is async. Open exactly one resource per call. Return services for
DI:

```ts
async boot({ $config }) {
  // Optional: read config injected by `defineApp(name, { config })`.
  const timeoutMs = ($config['MY_PKG_TIMEOUT_MS'] as number | undefined) ?? 5000;

  const myClient = new MyClient(options.url, { timeoutMs });
  await myClient.connect();

  return { myClient };
}
```

If `boot` opens multiple resources and one of them fails, clean up the
partial state yourself before throwing — the kernel only disposes pips
whose `boot` returned successfully.

```ts
async boot() {
  const a = await openA();
  try {
    const b = await openB();
    return { a, b };
  } catch (err) {
    await a.close();
    throw err;
  }
}
```

## Consuming other services

If your adapter needs a service from another pip (say, a logger), declare
it in `needs` — the hook context delivers it typed, and the app builder
refuses composition orders that can't satisfy it:

```ts
import { pip, service } from '@arki/dot/pip';

pip({
  name: 'my-pkg',
  needs: { log: service<Logger>() },
  async boot({ log }) {
    log.info('my-pkg booting');
    return { myClient: await open() };
  },
});
```

## Cleanup in `dispose`

`dispose` runs in reverse declaration order — your `needs` are still alive
when it runs. The context carries your own published services plus your
needs:

```ts
async dispose({ myClient }) {
  await myClient.close();
}
```

`stop` runs first if the pip has active work (workers, subscribers).
`dispose` runs even if `stop` failed — the kernel collects per-pip
failures into an aggregate `DotLifecycleError`.

## Manifest contribution beyond services

For adapters that expose routes or jobs, use the registration helpers:

```ts
configure(ctx) {
  ctx.registerService('myClient', 'custom');
  ctx.registerRoute({
    id: 'health',
    method: 'GET',
    path: '/_health/my-pkg',
    transport: 'http',
  });
}
```

Dependency edges are not declared — the kernel observes them from actual
service wiring at boot time and writes them into `app.manifest.dependencies`.

## Diagnostics — stable codes and remediation

When a hook throws, the kernel wraps the error into a `DiagnosticIssue`.
Make every error actionable:

```ts
async boot() {
  if (!options.url) {
    throw Object.assign(new Error(`[${name}] url is required`), {
      code: 'MY_PKG_E001',
      remediation: 'Pass options.url to myPkg(...) or set MY_PKG_URL.',
      docsUrl: 'https://example.com/my-pkg/docs#configuration',
    });
  }
  // ...
}
```

The `code`, `remediation`, and `docsUrl` propagate into
`app.diagnostics.issues`. Agents read these directly.

Use the prefix `<PKG>_E<NNN>` (e.g., `MY_PKG_E001`) to keep codes
package-scoped and easy to grep.

## Testing your adapter

Use `@arki/dot`'s test harness:

```ts
import { bootTestApp } from '@arki/dot';
import { describe, expect, it } from 'vitest';

import { myPkg } from '../src/dot.js';

describe('myPkg adapter', () => {
  it('publishes myClient as a service', async () => {
    const app = await bootTestApp([myPkg({ url: 'memory://' })]);
    expect(app.services.myClient).toBeDefined();
    await app.dispose();
  });

  it('emits MY_PKG_E001 when url is missing', async () => {
    const builder = bootTestApp([
      myPkg({} as Parameters<typeof myPkg>[0]), // intentionally invalid
    ]);
    await expect(builder).rejects.toMatchObject({ code: 'DOT_LIFECYCLE_E003' });
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

Import the kernel from `@arki/dot/pip` (a narrow entry that exports
`pip`, `service`, `token`, `rename`, and the pip types — no CLI).
This minimises what the adapter pulls in.

## Canonical examples

See the official adapters for reference:

- `@arki/env/dot` — env validation via Zod (sync boot, no cleanup).
- `@arki/kv/dot` — Redis-backed KV (async boot, dispose closes the client).
- `@arki/db/dot` — Drizzle ORM (async boot, dispose closes the pool).

Each of these is fewer than 100 lines and demonstrates a different
combination of the hooks.

## See also

- [Pip authoring](./pip-authoring.md) — the general `Pip`
  contract.
- [Lifecycle](./lifecycle.md) — hook ordering and failure semantics.
- [Diagnostics](./diagnostics.md) — emitting actionable issues.
- [Release policy](./release-policy.md) — versioning your adapter against
  `@arki/dot`.
