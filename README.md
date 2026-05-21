# ARKI

A TypeScript-first application composition framework.

Tiny kernel. Package-owned adapters. First-class diagnostics.

```bash
bun add @arki/dot
```

## What DOT is

[`@arki/dot`](packages/dot) is the kernel — the framework that ties every
other `@arki/*` package together. A DOT app is composed of **pips**:
small, lifecycle-aware units that publish typed services and compose
deterministically. The kernel itself is tiny; everything else lives in
a package you opt into with `.use()`.

```ts
import { defineApp } from '@arki/dot';
import { env }       from '@arki/env/dot';
import { db }        from '@arki/db/dot';
import { kv }        from '@arki/kv/dot';

export const app = await defineApp('billing')
  .use(env({ schema }))
  .use(db({ schema: dbSchema }))
  .use(kv())
  .boot();

// Each .use() extends the inferred app type. After .boot() the services
// are typed end-to-end — no DI container, no decorators, no manual wiring.

app.services.env.DATABASE_URL;     // string (inferred from your env schema)
app.services.db.query.users;       // typed query builder
await app.services.kv.get('key');  // typed get/set
```

### The lifecycle

Every pip plugs into the same five hooks, run in dependency order:

```text
configure  ─►  boot  ─►  start  ─►  stop  ─►  dispose
```

- **`configure`** — read env, validate, register schemas. No I/O.
- **`boot`**      — open connections, run migrations, hydrate caches.
- **`start`**     — begin accepting work (HTTP listen, queue subscribe).
- **`stop`**      — drain in-flight work; refuse new requests.
- **`dispose`**   — release resources; final flush.

Failure at any hook produces a `DotDiagnostic` with a stable code, a
severity, and a remediation URL. The kernel collects them in the
`DotAppManifest` so a CLI, a probe, or an agent can read the same shape.

### Typed services, no DI container

Each pip declares what it `provides`. The kernel infers `app.services.<key>`
from the chain of `.use()` calls — so adding a pip extends the types,
and removing one is a compile-time break, not a runtime surprise. No
decorators. No reflection. No global registry.

### Agent-native by construction

- Every error has a stable code and a remediation URL.
- Every CLI command emits a structured JSON envelope under `--json`.
- `dot doctor` returns a machine-readable snapshot of the app graph.
- `dot explain` returns the static manifest — what the app *would* boot.

Read [`packages/dot/README.md`](packages/dot/README.md) for the full
DOT reference: `defineApp`, the pip contract, lifecycle hooks, manifest
and diagnostics shape, and the CLI.

## The problem ARKI exists to solve

Every TypeScript backend eventually composes:

> `env + db + kv + queue + auth + RPC + jobs + diagnostics + tests`

You can wire this by hand. Most teams do. But the glue is the bug
surface, and the glue rots faster than the libraries it connects.

ARKI is that glue, factored into composable packages, with a kernel
that owns the lifecycle and a release pipeline that proves every
published package passes the same gates — pack audit, leak scan,
fixture install, typecheck, docs coverage. Failed gate, no publish.

## Quick start

```bash
bunx @arki/dot new my-app
cd my-app
bun install
bun run dev
```

## Packages

Every package below is published independently to npm under the
`@arki/*` scope. Each one has its own README with examples and
contract notes.

| Wave | Packages |
| ---- | -------- |
| **Kernel** | [`@arki/dot`](packages/dot) — application composition kernel |
| **Foundation** | [`@arki/assert`](packages/assert), [`@arki/contracts`](packages/contracts), [`@arki/log`](packages/log), [`@arki/env`](packages/env), [`@arki/ts`](packages/ts), [`@arki/resilience`](packages/resilience), [`@arki/date`](packages/date), [`@arki/string`](packages/string), [`@arki/slugify`](packages/slugify), [`@arki/clock`](packages/clock) |
| **Adapters** | [`@arki/db`](packages/db), [`@arki/kv`](packages/kv), [`@arki/event-sourcing`](packages/event-sourcing) |

## Doctrine

Five rules we don't break to ship faster:

1. **No shortcuts.** Every published package passes the release
   scorecard (pack audit, leak scan, fixture install, typecheck,
   docs coverage) before it is published. Failed gate, no publish.
2. **Test the boundary, not the implementation.** Packed tarballs,
   public exports, CLI output, JSON envelopes, generated apps — those
   are what is tested. Private helpers are not tested directly.
3. **Framework quality bar: Laravel / Rails-level discipline.**
   Coherent conventions. Excellent generators. Documented errors.
   Tiny polished kernel over broad rough framework.
4. **Peer respect, not ridicule.** AdonisJS, ElysiaJS, Hono, NestJS
   are excellent at the jobs they were built for. DOT does a
   different job. We learn from them.
5. **Agents are first-class readers.** Every error has a stable code.
   Every CLI has a `--json` envelope. Every page has an `llms.txt`
   entry. The site is tested for agent comprehension, not only human
   comprehension.

## Status

ARKI is on the experimental track (`0.0.x` for foundation packages,
`0.1.x` for the kernel and adapters). The kernel is stable in shape;
adapters are stable per their per-package README; the public API may
evolve before `1.0`. The release scorecard at the upstream workspace
gates every publish.

## License

MIT. See [`LICENSE`](LICENSE).

## Contributing

This repository is the **generated public mirror** of the ARKI
workspace. Sources are not edited here directly — open issues and
discussion threads instead, and changes land upstream and re-export.
