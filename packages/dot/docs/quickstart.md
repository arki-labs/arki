# Quickstart

Build a two-plugin app, break it on purpose, read the error, fix it, and
inspect it with `dot explain` and `dot doctor`. It takes about ten minutes.

Every output on this page is printed by the block above it each time the docs
are tested (`bun run test:docs`). It is the real output, not a copy.

```text
 database ── provides db ──▶ orders
 (boots 1st)                  (boots 2nd)
```

## 1. Install

```sh
bun add @arki/dot
```

## 2. Write the app

Create `src/app.ts`. Start with a database plugin. It provides one service,
`db`. Here it is an array in memory, so the tutorial needs no Postgres:

```ts from="docs/examples/quickstart.ts#database"
type Order = { readonly id: number; readonly cents: number };

export const database = plugin({
  name: 'database',
  provides: {
    // A stand-in for a real client. It is a plain array, so nobody gets paged at 3 a.m.
    db: () => {
      const rows: Order[] = [];
      return {
        insert: (row: Order) => rows.push(row),
        count: () => rows.length,
      };
    },
  },
});
```

Then an orders plugin. It **needs** `db` and **provides** `orders`:

```ts from="docs/examples/quickstart.ts#orders"
export const orders = plugin({
  name: 'orders',
  needs: { db: database.provides.db }, // the handle, not a string: a typo cannot compile
  provides: {
    orders: ({ db }) => ({
      place: (cents: number): Order => {
        const order = { id: db.count() + 1, cents };
        db.insert(order);
        return order;
      },
    }),
  },
});
```

Mount both, provider first, and export the builder:

```ts from="docs/examples/quickstart.ts#app"
export default defineApp('shop').use(database).use(orders);
```

Why export the builder and not a booted app: `dot explain` and `dot doctor`
own the lifecycle. They decide how far the app goes, and they clean up after
it.

## 3. Make the mistake

Swap the two `.use()` calls, so `orders` comes before the plugin it needs:

```js from="docs/examples/quickstart-wrong-order.mjs#wrong-order"
export default defineApp('shop').use(orders).use(database);
```

In TypeScript, your editor rejects the `.use(orders)` line. The last line of
the type error says what to do:

```text
Property ''DOT: this unit needs services that nothing before it provides. Mount their providers earlier (.use → .features → .serve)'' is missing in type ...
```

The compiler is the first guard. The kernel is the second, for code the
compiler never sees: plain JavaScript, or TypeScript that Bun runs without a
type check. The example file is JavaScript, so it loads. Run `dot doctor` on
it:

```sh
dot doctor --app src/app.js --json | jq -r '.error.code, .error.data.underlyingCode, .error.data.causeMessage'
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
console.log(error.data.underlyingCode);
console.log(error.data.causeMessage);
```

```text
dot.app_lifecycle_failed
ARKI_DOT_E020
Plugin "orders" needs "db", which "database" provides — but "database" is mounted after it (position 2; "orders" is 1).
Mount "database" with .use() before "orders".
```

Read it from the inside out:

- `dot.app_lifecycle_failed` is the command's failure: the app failed while
  the CLI prepared it. The process exits with code `3`.
- `ARKI_DOT_E020` is the kernel's code: a provider is mounted after its
  consumer. Codes never change meaning, so match on them, not on the text.
- The message names both plugins and both positions.

The kernel caught it at `configure`, before any `boot` hook ran. Nothing was
opened, so there is nothing to clean up.

## 4. Fix it

Put `database` first again, as in step 2. The type error goes away, and the
kernel has nothing to say.

## 5. Read the graph: `dot explain`

```sh
dot explain --app src/app.ts --json | jq -c '.data.plugins[], .data.dependencies[]'
```

Side effects: `dot explain` imports the app file, so its top-level code runs.
Then it calls `configure` on each plugin. It never boots: no `provides`
factory runs, no connection opens. A plugin that keeps the rules does no I/O
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
{"name":"database","dependencies":[],"provides":["db"]}
{"name":"orders","dependencies":["db"],"provides":["orders"]}
{"from":"orders","to":"database","kind":"requires","key":"db"}
```

`.data` is the manifest itself. There is no `.data.manifest`.

## 6. Check it boots: `dot doctor`

```sh
dot doctor --app src/app.ts --json | jq -c '.data.status, (.data.plugins[] | {plugin, status}), .data.issues'
```

Side effects: `dot doctor` boots the app for real. Every `provides` factory
and every `boot` hook runs, so connections open and a migrations plugin
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
{"plugin":"orders","status":"ok"}
[]
```

An empty `issues` array means the app is healthy. `.data` is the diagnostics
snapshot itself. There is no `.data.diagnostics`.

## Next steps

- [Dependency injection](./di.md): handles, tokens, `rename`, lazy services
  and features.
- [Plugin authoring](./plugin-authoring.md): write a plugin with all five
  hooks.
- [The `dot` command](./cli.md): `dot new` scaffolds a full app, `dot dev`
  runs it.
- [Deploy an app](./recipes/deploy.md): ship it in a container.
