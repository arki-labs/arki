# @arki/live for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. A live procedure declares the tables it reads in contract meta: `oc.meta(live({ reads: [posts, users] }))`. The meta is plain JSON (`{ live: { version: 1, reads: [{ schema, table }] } }`).
2. A statement trigger per table publishes `{ v: 1, tag: { schema, table }, txid }` on `arki_live_<app>_v1` at commit; `txid` is `pg_current_xact_id()` as a decimal string. A rollback publishes nothing; one transaction publishes once per table. `change` frames carry the batch's `txids`.
3. The hub (`createLiveHub`) unions tags for `batchMs`, numbers each frame `${epoch}.${seq}`, keeps a bounded ring, and feeds every open stream.
4. A stream starts with `begin`: `resume` when its cursor is of this epoch and still in the ring (the missed frames follow), else `reset` (refetch every live query). A listener gap ends every stream with `gap` and the next `ready` starts a new epoch.
5. `liveRead()` + `snapshot()` give one procedure call one `REPEATABLE READ READ ONLY` transaction, so all its reads agree.

## Task map

### Declare what a procedure reads

1. Add `LiveMeta` to the contract's meta type: `oc.$meta<AppMeta & LiveMeta>({})`.
2. On each live procedure: `.meta(live({ reads: [table, ...] }))` from `@arki/live/drizzle`. Spread it next to app meta: `.meta({ auth: 'user', ...live({ reads: [posts] }) })`.
3. Library file: `src/drizzle/tables.ts`.

### Give a procedure one snapshot

1. `liveRead((context: { readonly db: Db; readonly repos: Deps['repos'] }) => snapshot(context.db, tx => context.repos.withTx(tx)))`, once per feature.
2. `impl.list.use(thatMiddleware).handler(({ context }) => context.liveRead.posts.page(1))`.
3. Library files: `src/drizzle/snapshot.ts`, `src/orpc/read.ts`.

```ts
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

import { snapshot } from '@arki/live/drizzle';

declare const db: NodePgDatabase;
const both = await snapshot(
  db,
  tx => tx,
)(async tx => {
  const a = await tx.execute(sql`select count(*) from posts`);
  const b = await tx.execute(sql`select count(*) from posts`);
  return [a.rows, b.rows];
});
export { both };
```

### Publish tables from Postgres

1. Generate the trigger SQL: `liveMigration({ app: 'blog', tables: [tableTag(posts), tableTag(users)] })`. Paste `up` and `down` into a Drizzle custom migration (`drizzle-kit generate --custom`). The library never applies it.
2. A partitioned table: a write straight into a leaf skips the root's trigger. Add `leaves: [{ leaf, root }]`; the leaf's trigger publishes the root's tag.
3. At boot, `verifyLiveTriggers(db, { app, tables })` lists every hole (`missing-table`, `missing-trigger`, `disabled`, `wrong-function`, `wrong-events`, `wrong-args`, `partition-leaf-uncovered`). A view or a materialized view counts as missing: publish it with `touch(tx, app, tag)` inside the writing transaction.
4. `createLiveHub({ source: pgSource({ pool: listenPool, app: 'blog' }) })`, with a pool of its own. The hub is ready once `LISTEN` succeeds; a lost listener or an unreadable payload is a `gap`, and the reconnect is a new epoch.
5. Library files: `src/pg/migration.ts`, `src/pg/verify.ts`, `src/pg/touch.ts`, `src/pg/source.ts`.

### Drive the hub in a test

1. `const source = fakeSource(); const hub = createLiveHub({ source }); await hub.start(); source.emit({ kind: 'ready' })`.
2. `hub.open({ cursor, signal })` attaches at once; iterate it for `begin`, `change`, `gap`, `bye`.
3. `source.emit({ kind: 'change', tags })` then wait `batchMs`; `source.emit({ kind: 'gap' })` to simulate a lost listener.
4. Library files: `src/hub.ts`, `src/testing.ts`; the scripted client in `src/tests/scripted-client.ts`.

## Rules that bite

- Read only through `context.liveRead` inside a `liveRead` handler; the root `db` is another snapshot.
- `snapshot(tx, ...)` is refused (types and E001): pass the root database.
- A `liveRead` select typed `(context: Deps)` fails when `db` is `entrypointOnly`: type it with the handler context.
- Never reuse an epoch: a custom `epoch()` must return a new 12-character `[a-z0-9]` value each call (E001 otherwise).
- A stream that falls `subscriberFrames` behind gets `bye`; reconnect with the cursor.
- Hints say only which table changed. Every refetch is authorized by its own procedure.

## Errors

| Code             | Meaning                                                                                           | What to do                              |
| ---------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `ARKI_LIVE_E001` | Bad meta or options, `liveRead()` without live meta, `snapshot()` given a `tx`, a repeated epoch. | Fix the declaration; see `remediation`. |
| `ARKI_LIVE_E002` | Missing, disabled or incompatible triggers.                                                       | Apply the live migration.               |
| `ARKI_LIVE_E003` | The hub is not ready.                                                                             | Retry with backoff.                     |
| `ARKI_LIVE_E004` | A malformed cursor, frame or payload.                                                             | Send back cursors exactly as received.  |
| `ARKI_LIVE_E005` | 401/403 on the stream.                                                                            | Re-authenticate.                        |
| `ARKI_LIVE_E006` | A bounded resource was reached.                                                                   | Reconnect; check the limits.            |

## Verify

```sh
bun run build
bun run typecheck
bun run test
bun run lint
bun run test:docs
bun run test:runtimes
```
