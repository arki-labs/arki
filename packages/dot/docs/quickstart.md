# Quickstart

Build a three-unit app, break it on purpose, read the error, fix it, and
inspect it with `dot explain` and `dot doctor`. It takes about ten minutes.

Every output on this page is printed by the block above it each time the docs
are tested (`bun run test:docs`). It is the real output, not a copy.

```text
 database ── provides db ──▶ sessions   (infra)
     │
     └────── provides db ──▶ orders     (feature)
```

An app has three steps, always in this order:
`defineApp(name).infra(...).features([...]).entrypoints(...)`.
**Infra** is what your code talks to: a database, a cache, a mailer.
**Features** are your domain logic. **Entrypoints** are what calls your
code from outside: an HTTP server, a worker. This app has no entrypoint yet.

## 1. Install

```sh
bun add @arki/dot
```

## 2. Write the app

Create `src/app.ts`. Start with a database. It is an `infra` unit that
provides one service, `db`. Here the tables are arrays in memory, so the
tutorial needs no Postgres:

```ts from="docs/examples/quickstart.ts#database"
type Order = { readonly id: number; readonly cents: number };

export const database = infra({
  name: 'database',
  provides: {
    // A stand-in for a real client: tables are plain arrays, so nobody gets paged at 3 a.m.
    db: () => {
      const tables = new Map<string, unknown[]>();
      const table = (name: string): unknown[] => tables.get(name) ?? tables.set(name, []).get(name) ?? [];
      return {
        insert: (name: string, row: unknown) => table(name).push(row),
        count: (name: string) => table(name).length,
      };
    },
  },
});
```

A session store is infra too, and it is built on the database. It
**needs** `db` and **provides** `sessions`:

```ts from="docs/examples/quickstart.ts#sessions"
export const sessions = infra({
  name: 'sessions',
  needs: { db: database.provides.db }, // the handle, not a string: a typo cannot compile
  provides: {
    sessions: ({ db }) => ({
      open: (userId: string) => {
        db.insert('sessions', { userId });
        return { userId };
      },
    }),
  },
});
```

Orders are not infrastructure. They are what the shop does, so they are a
feature. The smallest feature needs `db`, builds a usecase from it, and
provides it. A `provides` factory sees only the usecases. The empty
`.entrypoints()` finishes it:

```ts from="docs/examples/quickstart.ts#orders"
export const orders = defineFeature('orders')
  .needs({ db: database.provides.db })
  .usecases({
    place:
      ({ db }) =>
      (cents: number): Order => {
        const order = { id: db.count('orders') + 1, cents };
        db.insert('orders', order);
        return order;
      },
  })
  .provides({ orders: ({ usecases }) => ({ place: usecases.place }) })
  .entrypoints(); // nothing calls orders from outside yet
```

Mount the infra in boot order, provider first, then the feature, and
export the builder:

```ts from="docs/examples/quickstart.ts#app"
export default defineApp('shop').infra(database, sessions).features([orders]);
```

Why export the builder and not a booted app: `dot explain` and `dot doctor`
own the lifecycle. They decide how far the app goes, and they clean up after
it.

## 3. Make the mistake

Swap the two infra units, so `sessions` comes before the `database` it needs:

```js from="docs/examples/quickstart-wrong-order.mjs#wrong-order"
export default defineApp('shop').infra(sessions, database).features([orders]);
```

In TypeScript, your editor rejects the `.infra(...)` line. The error names
the guard, and its type holds the reason, a `NeedsError` that starts from
an empty set of services (`EmptyShape`) and needs `db`:

```text
Property ''DOT: a unit in this list cannot be mounted at its position'' is missing in type ...
  ... NeedsError<EmptyShape, WireNeeds<{ db: Handle<..., "db", "database">; }>> ...
```

The `.features([orders])` call shows the same error, because `orders` needs
`db` too. Fix the first error and both go away.

The compiler is the first guard. The kernel is the second, for code the
compiler never sees: plain JavaScript, or TypeScript that Bun runs without a
type check. The example file is JavaScript, so it loads. Run `dot doctor` on
it:

```sh
dot doctor --app src/app.js --json | jq '.error.code, .error.data'
```

This page runs the same command line in-process with `program.main`:

```ts run expect
import { program } from '@arki/dot/cli';

let out = '';
await program.main(['doctor', '--app', 'docs/examples/quickstart-wrong-order.mjs', '--json'], {
  stdout: text => {
    out += text;
  },
});
const { error } = JSON.parse(out);
console.log(error.code);
console.log(JSON.stringify(error.data));
```

```text
failure.unexpected_defect
null
```

`failure.unexpected_defect` is the canonical managed defect. The process exits
with code `3`. Its original cause is private, so JSON data is null. In process,
`UnexpectedDefect.cause` retains the kernel diagnostic error with stable
`ARKI_DOT_E020` metadata naming both units and their positions. Read the local
cause, or fix the wiring with the compiler's provider-order error.

The kernel caught it at `configure`, before any `boot` hook ran. Nothing was
opened, so there is nothing to clean up.

## 4. Fix it

Put `database` first again, as in step 2. The type errors go away, and the
kernel has nothing to say.

## 5. Read the graph: `dot explain`

```sh
dot explain --app src/app.ts --json | jq -c '.data.plugins[], .data.dependencies[]'
```

Side effects: `dot explain` imports the app file, so its top-level code runs.
Then it calls `configure` on each unit. It never boots: no `provides`
factory runs, no connection opens. A unit that keeps the rules does no I/O
in `configure`, so this is safe to run against production config.

```ts run expect
import { program } from '@arki/dot/cli';

let out = '';
await program.main(['explain', '--app', 'docs/examples/quickstart.ts', '--json'], {
  stdout: text => {
    out += text;
  },
});
const { data } = JSON.parse(out);
for (const entry of [...data.plugins, ...data.dependencies]) console.log(JSON.stringify(entry));
```

```text
{"name":"database","role":"infra","dependencies":[],"provides":["db"]}
{"name":"sessions","role":"infra","dependencies":["db"],"provides":["sessions"]}
{"name":"orders","role":"feature","dependencies":["db"],"provides":["orders.usecases","orders.services","feature.orders","orders"]}
{"from":"sessions","to":"database","kind":"requires","key":"db"}
{"from":"orders","to":"database","kind":"requires","key":"db"}
```

A feature compiles to one unit with the role `feature`. Next to `orders`, it
provides three keys the kernel uses to find its parts: its usecases, its
services, and the feature itself.

`.data` is the manifest itself. There is no `.data.manifest`.

## 6. Check it boots: `dot doctor`

```sh
dot doctor --app src/app.ts --json | jq -c '.data.status, (.data.plugins[] | {plugin, status}), .data.issues'
```

Side effects: `dot doctor` boots the app for real. Every `provides` factory
and every `boot` hook runs, so connections open and a migrations unit
applies its migrations. Then it disposes the app. It never calls `start`, so
workers and servers stay off. Point it at a database you are allowed to
change.

```ts run expect
import { program } from '@arki/dot/cli';

let out = '';
await program.main(['doctor', '--app', 'docs/examples/quickstart.ts', '--json'], {
  stdout: text => {
    out += text;
  },
});
const { data } = JSON.parse(out);
console.log(JSON.stringify(data.status));
for (const { plugin, status } of data.plugins) console.log(JSON.stringify({ plugin, status }));
console.log(JSON.stringify(data.issues));
```

```text
"success"
{"plugin":"database","status":"ok"}
{"plugin":"sessions","status":"ok"}
{"plugin":"orders","status":"ok"}
[]
```

An empty `issues` array means the app is healthy. `.data` is the diagnostics
snapshot itself. There is no `.data.diagnostics`.

## Next steps

- [Dependency injection](./di.md): handles, tokens, `rename`, lazy services
  and features.
- [Unit authoring](./unit-authoring.md): write a unit with all five
  hooks.
- [The `dot` command](./cli.md): `dot new` scaffolds a full app, `dot dev`
  runs it.
- [Deploy an app](./recipes/deploy.md): ship it in a container.
