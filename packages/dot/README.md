# @arki/dot

> TypeScript-first application composition framework for the ARKI package family.

`@arki/dot` is the kernel that wires **pips**, lifecycle hooks, dependency
graphs, and diagnostics into a deterministic application boot. It gives library
authors a stable contract for declaring how their package participates in an
app, and gives app developers a single place to wire those packages together.

## What is a pip?

A **pip** is the unit a DOT app is built from — one self-describing,
lifecycle-aware piece of an application. Each pip:

- declares a **name**, **version**, and the kinds of **services it provides**;
- runs a **5-hook lifecycle** — `configure` → `boot` → `start` → `stop` → `dispose`;
- **publishes typed services** to a shared, type-safe registry that later pips
  can read from;
- **composes deterministically** — pips boot in declaration order and dispose
  in reverse.

The name comes from the small dots on dice, dominoes, and music notation:
each pip is one small mark, and the *combination* of pips is what gives the app
its value. Two pips on a die make a value of two; six pips make six. The pips
**are** the app — not optional add-ons to a hidden core.

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
| `dispose`   | Free resources after `stop`.                                        |

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

```
defined ──configure()──▶ configured ──boot()──▶ booted ──start()──▶ started
                                                                       │
                       disposed ◀──dispose()── stopped ◀──stop()───────┘
```

`boot()` runs `configure()` implicitly if you skipped it. `start()` runs
`boot()` implicitly. `stop()` and `dispose()` always run in reverse
declaration order, even when an earlier hook failed — failure isolation is
part of the contract.

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

# Every command supports --json for agent-friendly output.
dot explain --app ./my-app.ts --json | jq '.data.pips'
```

The CLI emits the same envelope shape as the in-process diagnostics snapshot
(`app.diagnostics`), so the same downstream tools can consume either.

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
own packages and consume `@arki/dot` as a peer dependency.

This keeps the kernel free of optional dependencies and lets each adapter
ship at its own cadence.

## Documentation

The full docs live in [`docs/`](./docs):

- [Principles](./docs/principles.md) — **read first.** The five rules every
  API, error, and PR is measured against. Slightly playful, very precise.
- [Quickstart](./docs/quickstart.md) — boot your first app in five minutes.
- [Pip authoring](./docs/pip-authoring.md) — write your own `DotPip`.
- [Lifecycle](./docs/lifecycle.md) — the 5-hook contract.
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
