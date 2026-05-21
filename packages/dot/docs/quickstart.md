# Quickstart

Boot your first DOT app in five minutes.

## Install

```sh
npm install @arki/dot @arki/env zod
# or
pnpm add @arki/dot @arki/env zod
# or
bun add @arki/dot @arki/env zod
```

`@arki/dot` is the kernel. `@arki/env` is one of the package-owned adapters
(it exposes `@arki/env/dot` as an optional adapter entry). `zod` validates
the env schema.

## Define your app

Create `src/app.ts`:

```ts
import { defineApp } from '@arki/dot';
import { env } from '@arki/env/dot';
import { z } from 'zod';

export const app = await defineApp('my-app')
  .use(
    env({
      schema: {
        PORT: z.coerce.number().default(3000),
        NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
      },
    }),
  )
  .boot();

console.log(`booted ${app.name} on port ${app.services.env.PORT}`);
```

That's the whole boot path. `defineApp(name)` returns a builder, `.use(pip)`
registers a pip, and `.boot()` runs the `configure` and `boot` hooks in
topological order.

`app.services.env` is typed from the Zod schema — `PORT` is `number`, not
`string`. No casts, no `as any`.

## Inspect the static graph

Every DOT app exposes a `manifest` — a declarative description of what is
registered:

```ts
console.log(JSON.stringify(app.manifest, null, 2));
```

You will see five top-level arrays:

```json
{
  "app": { "name": "my-app" },
  "pips": [ { "name": "env", "version": "0.1.0", "dependencies": [], "provides": ["env"] } ],
  "routes": [],
  "services": [ { "name": "env", "pip": "env", "kind": "env" } ],
  "lifecycle": [ { "pip": "env", "hooks": ["configure", "boot"] } ],
  "dependencies": []
}
```

The CLI prints the same data:

```sh
npx dot explain --json
```

## Check runtime health

```ts
console.log(JSON.stringify(app.diagnostics, null, 2));
```

Or from the CLI:

```sh
npx dot doctor --json | jq '.data.diagnostics.issues'
```

`app.diagnostics` is a `DotDiagnosticsSnapshot`: same five-array shape as the
manifest, plus runtime status for each pip/route/service and an `issues`
array. Empty `issues` means the app is healthy.

## Stop and dispose

When you are done:

```ts
await app.stop();
await app.dispose();
```

`stop` halts active work (workers, listeners) in reverse-topological order.
`dispose` releases resources (connections, file handles) in the same order.
Both are idempotent — calling them twice is safe.

## Next steps

- [Pip authoring](./pip-authoring.md) — write your own `DotPip`.
- [Lifecycle](./lifecycle.md) — what each hook can (and cannot) do.
- [Diagnostics](./diagnostics.md) — the full `dot explain` / `dot doctor`
  contract.
- [Adapter authoring](./adapter-authoring.md) — expose your own package.

The full working code for this tutorial lives at
[`examples/quickstart.ts`](./examples/quickstart.ts).
