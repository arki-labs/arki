# @arki/dot

> TypeScript-first application composition framework for the ARKI package family.

`@arki/dot` is the kernel that wires plugins, lifecycle hooks, dependency
graphs, and diagnostics into a deterministic application boot. It gives library
authors a stable contract for declaring how their package participates in an
app, and gives app developers a single place to wire those packages together.

## Installation

```bash
npm install @arki/dot
# or
bun add @arki/dot
```

## Quick start

```ts
import { defineApp, defineDotPlugin } from '@arki/dot';

const billingPlugin = defineDotPlugin({
  name: 'billing',
  version: '1.0.0',
  configure(ctx) {
    // Validate config, register schemas, no I/O.
  },
  async boot(ctx) {
    // Open connections, register providers.
    return { stripe: makeStripeClient() };
  },
  async start(ctx) {
    // Begin processing — workers, subscriptions, schedulers.
  },
  async stop() {
    // Stop processing — drain workers, unsubscribe.
  },
  async dispose() {
    // Close connections, free resources.
  },
});

const app = defineApp('acme')
  .use(billingPlugin);

await app.configure();
await app.boot();
await app.start();

// app.manifest, app.diagnostics — agent-friendly envelopes.

await app.stop();
await app.dispose();
```

## Plugin authoring

`defineDotPlugin(config)` accepts five lifecycle hooks. Each receives a
phase-specific context with services contributed by earlier plugins:

| Hook        | Purpose                                                          |
| ----------- | ---------------------------------------------------------------- |
| `configure` | Validate static config; declare schemas, routes, services. No I/O. |
| `boot`      | Open connections; register providers; return a typed kit.       |
| `start`     | Begin processing (workers, subscribers, schedulers).             |
| `stop`      | Stop processing in reverse dependency order.                     |
| `dispose`   | Free resources after `stop`.                                     |

Plugins can declare dependencies on others by name. The kernel computes a
topological order and runs hooks deterministically — same input, same order,
every time.

## Lifecycle

`defineApp(name)` returns a builder. Calling `.use(plugin)` accumulates
plugins. The lifecycle then flows:

```
defined ──configure()──▶ configured ──boot()──▶ booted ──start()──▶ started
                                                                       │
                       disposed ◀──dispose()── stopped ◀──stop()───────┘
```

`boot()` runs `configure()` implicitly if you skipped it. `start()` runs
`boot()` implicitly. `stop()` and `dispose()` always run in reverse dependency
order, even when an earlier hook failed — failure isolation is part of the
contract.

## CLI

`@arki/dot` ships a small CLI for inspecting and validating apps:

```bash
# Print the app manifest as a structured envelope.
dot explain --app ./my-app.ts

# Run boot-time diagnostics; non-zero exit if any check fails.
dot doctor --app ./my-app.ts

# Both commands support --json for agent-friendly output.
dot explain --app ./my-app.ts --json | jq '.manifest.plugins'
```

The CLI emits the same envelope shape as the in-process diagnostics snapshot
(`app.diagnostics`), so the same downstream tools can consume either.

## Architecture

`@arki/dot` is intentionally small: it defines the contracts (plugin shape,
lifecycle hooks, manifest schema, diagnostics envelope) and runs them. Adapters
that bridge databases, queues, auth providers, and HTTP routers live in their
own packages and consume `@arki/dot` as a peer dependency.

This keeps the kernel free of optional dependencies and lets each adapter
ship at its own cadence.

## Documentation

The full docs live in [`docs/`](./docs):

- [Quickstart](./docs/quickstart.md) — boot your first app in five minutes.
- [Plugin authoring](./docs/plugin-authoring.md) — write your own `DotPlugin`.
- [Lifecycle](./docs/lifecycle.md) — the 5-hook contract.
- [Diagnostics](./docs/diagnostics.md) — `app.manifest`, `app.diagnostics`,
  `dot explain`, `dot doctor`.
- [Adapter authoring](./docs/adapter-authoring.md) — expose your package as
  a DOT plugin.
- [Agent guide](./docs/agent-guide.md) — how coding agents inspect, modify,
  and verify DOT apps.
- [Release policy](./docs/release-policy.md) — SemVer and deprecation.

Agent-discoverable index: [`llms.txt`](./llms.txt).

## License

MIT — see [LICENSE](./LICENSE).
