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

An adapter exports a factory function that returns a `DotPip`:

```ts
// my-pkg/src/dot.ts
import { defineDotPip, type DotPip } from '@arki/dot/pip';

import { MyClient } from './index.js';

export type MyPkgDotOptions = {
  readonly url: string;
  readonly name?: string;
};

export type MyPkgServices = {
  readonly myClient: MyClient;
};

export function myPkg(options: MyPkgDotOptions): DotPip<MyPkgServices> {
  const name = options.name ?? 'my-pkg';
  return defineDotPip<MyPkgServices>({
    name,
    version: '1.0.0',
    provides: ['my-pkg'],

    configure(ctx) {
      ctx.registerService('myClient', 'custom');
    },

    async boot() {
      const myClient = new MyClient(options.url);
      await myClient.connect();
      return { services: { myClient } };
    },

    async dispose({ services }) {
      await services.myClient.close();
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
async boot(ctx) {
  // Optional: read config injected by `defineApp(name, { config })`.
  const timeoutMs = (ctx.config['MY_PKG_TIMEOUT_MS'] as number | undefined) ?? 5000;

  const myClient = new MyClient(options.url, { timeoutMs });
  await myClient.connect();

  return { services: { myClient } };
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
    return { services: { a, b } };
  } catch (err) {
    await a.close();
    throw err;
  }
}
```

## Cleanup in `dispose`

`dispose` runs in reverse-topological order. Close everything you opened:

```ts
async dispose({ services }) {
  await services.myClient.close();
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
  ctx.declareDependency('env', 'requires');
}
```

Or use the declarative `manifest` field on the pip object — it accepts a
static value or a function that receives `services` and the pip name:

```ts
return defineDotPip<MyPkgServices>({
  name,
  manifest: {
    routes: [{ id: 'health', path: '/_health/my-pkg', transport: 'http' }],
  },
  // ...
});
```

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
`defineDotPip` and the pip types only — no `defineApp`, no CLI).
This minimises what the adapter pulls in.

## Canonical examples

See the official adapters for reference:

- `@arki/env/dot` — env validation via Zod (sync boot, no cleanup).
- `@arki/kv/dot` — Redis-backed KV (async boot, dispose closes the client).
- `@arki/db/dot` — Drizzle ORM (async boot, dispose closes the pool).

Each of these is fewer than 100 lines and demonstrates a different
combination of the hooks.

## See also

- [Pip authoring](./pip-authoring.md) — the general `DotPip`
  contract.
- [Lifecycle](./lifecycle.md) — hook ordering and failure semantics.
- [Diagnostics](./diagnostics.md) — emitting actionable issues.
- [Release policy](./release-policy.md) — versioning your adapter against
  `@arki/dot`.
