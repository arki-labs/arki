# @arki/live for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. A live procedure declares the tables it reads in contract meta: `oc.meta(live({ reads: [posts, users] }))`. The meta is plain JSON (`{ live: { version: 1, reads: [{ schema, table }] } }`).
2. A statement trigger per table publishes `{ v: 1, tag: { schema, table }, txid }` on `arki_live_<app>_v1` at commit; `txid` is `pg_current_xact_id()` as a decimal string. A rollback publishes nothing; one transaction publishes once per table. The txid stays in the hub: a `change` frame carries in `txids` the **receipts** of exactly the commits that wrote its own tables (`liveReceipts({ app, secret })`: an HMAC of the txid, 22 characters), never the raw id, which would reveal the database-wide transaction counter.
3. The hub (`createLiveHub`) keeps one envelope per transaction (its tables, and a scoped table's changed keys) inside an epoch, keeps `replayMs` of envelopes in a ring, and feeds every open stream through its view (`hub.open({ view })`, which `liveEndpoint` builds from the grant). The view applies before the stream's own `batchMs` window, queue and frame split: a change with no granted table or key never reaches the stream (no window, no queue slot, no early flush, no `bye`). The cursor a client sees is a position (epoch, hint number, time taken) sealed with AES-GCM under a key per hub start: opaque, 75 characters, so a client cannot count the hints its grant hides. Streams whose windows close at one position share one sealed cursor.
4. A stream starts with `begin`: `resume` when the hub can open its cursor, the epoch is current and the cursor is at most `replayMs` old (the missed hints follow, through the stream's grant and windows, as it would have got them live), else `reset` (refetch every live query). The decision never depends on how many hints passed. A listener gap ends every stream with `gap` and the next `ready` starts a new epoch; so does an overload (the ring reached `replayEnvelopes` or `replayBytes`) and a scoped statement's overflow (over `maxKeys` keys, a key over 512 bytes, a TRUNCATE under row-level security), which reset every client at once.
5. On the client, `LiveProvider` reads the stream (`createLiveClient`) and calls `invalidateQueries` by oRPC path: every live path on a reset, the affected paths on a change. For a scoped tag it invalidates only the queries whose input holds a changed key at the declared path (`'session'` paths whole), and on a `hello` with fewer keys it removes the queries of the lost keys.
6. `liveRead()` + `snapshot()` give one procedure call one `REPEATABLE READ READ ONLY` transaction, so all its reads agree.

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

### Scope a table by tenant

1. Declare once: `const scopes = liveScopes({ org: [[posts, posts.orgId]], user: [[memberships, memberships.userId]] })` (NOT NULL uuid, text, varchar or integer columns; one dimension per table, one key kind per dimension).
2. Meta: `live({ reads: [posts], scope: { org: 'input.orgId' } })` refetches only queries whose input holds a changed key; `'session'` refetches the path on any granted key. No `scope`: live only for `org: 'all'` grants.
3. `liveManifest(contract, { scopes })`, `liveMigration({ app, tables: [...liveTables(manifest), tableTag(memberships)], scopes, maxKeys })`, `verifyLiveTriggers(db, { app, tables, scopes, maxKeys })`; in Dot, `liveQueries({ scopes, reauthorize, maxKeys, ... })`.
4. `liveEndpoint({ hub, manifest, scopes, authorize, reauthorize: [tableTag(memberships)] })`; `authorize` returns `LiveGrant<'org' | 'user'>`: `{ scopes: { org: session.orgIds, user: [session.userId] } }` or `'all'`. At most 4 096 keys per dimension, normalized by kind.
5. `touch(tx, { app, scopes }, { schema, table, keys })` publishes keys by hand; with `scopes`, a scoped tag without keys is E001.
6. A table read by several tenants (a shared `users`) stays unscoped. Library files: `src/drizzle/scopes.ts`, `src/scopes.ts`, `src/http.ts`, `src/react.ts`, `src/pg/migration.ts`.

### Drive the hub in a test

1. `const source = fakeSource(); const hub = createLiveHub({ source, receipts }); await hub.start(); source.emit({ kind: 'ready' })`. Without `receipts` frames carry `txids: []`; with them, compare `txids` to `await receipts.of(txid)`.
2. `await hub.open({ cursor, view, signal })` opens the cursor, then attaches; iterate it for `begin`, `change`, `gap`, `bye`. `view: { tables, scopes: [{ tag, name, keys }] }` limits what the stream sees (tables omitted: every table; a keyed change of a table without a `scopes` entry is hidden). `begin` cursors are freshly sealed and `change` cursors are shared by streams whose windows close together, so compare modes and tags, never cursor strings.
3. `source.emit({ kind: 'change', tags })` then wait `batchMs`; `source.emit({ kind: 'gap' })` to simulate a lost listener.
4. Age and the overload caps: `limits: { replayMs, replayEnvelopes, replayBytes }`. With fake timers, `expect.poll` moves the fake clock while it waits: note `Date.now()` before the connect whose cursor's age you test.
5. Real Postgres: `src/tests/failure.pg.test.ts` has the barrier helpers (a held pool client, a role without LOGIN, a gated read, an open transaction).
6. Library files: `src/hub.ts`, `src/replay.ts`, `src/cursor.ts`, `src/testing.ts`; the scripted client in `src/tests/scripted-client.ts`.

### Add a live table

1. Meta: add the table to `live({ reads: [...] })` of every procedure that reads it.
2. Migration: regenerate `liveMigration({ app, tables: liveTables(liveManifest(contract)) })` and add the new table's trigger in a new custom migration. Never run DDL at boot.
3. Restart: the boot check (`verifyLiveTriggers`, E002) passes only once the migration ran.

### Debug "nothing updates"

1. `verifyLiveTriggers(db, { app, tables })` returns the holes; an empty array means every declared table publishes.
2. In `psql`: `LISTEN arki_live_<app>_v1;`, then write the table. No notification means no trigger (or a view: `touch` it).
3. `dot explain --json` lists each live procedure with its tables: a procedure missing there has no `live()` meta.
4. In the browser: `useLiveStatus()` is `live`? A hook on a path not in the manifest logs E001 (`DEBUG=arki:live:*`).

### Use live queries in React

1. Mount `<LiveProvider url="/api/live">` inside `QueryClientProvider`, once per `QueryClient`. Pass `keyPrefix` when the oRPC utils were built with a `path`.
2. `useLiveQuery(orpc.posts.list.queryOptions({ input }))`. Guard rendering with `isPending`. No `initialData`.
3. A mutation that returns `await receipts.of(txid)`, with `txid` = `pg_current_xact_id()::text` of its own transaction and `receipts` the hub's, can `await awaitTxId(queryClient, receipt)` in `onSuccess`. Never return the raw txid.
4. Server rendering: `setLiveCursor(queryClient, await hub.cursor())` first, then load the page's data, then `dehydrate`. Keep `staleTime` above 0 so hydrated data is not refetched on mount.
5. TanStack DB: `createCollection(queryCollectionOptions({ ...orpc.x.queryOptions({ input }), queryClient, getKey }))` from `@tanstack/query-db-collection`; the provider's invalidation refreshes it.
6. Sign-out or account switch: `queryClient.resetQueries()` and remount the provider with `key={userId}`, so the old account's data, fetches in flight and stream grant are gone (`src/tests/session.pg.test.ts`).
7. Tests: `waitForInvalidation(queryClient, ['posts', 'list'])` before the write; the real hub and `liveEndpoint(...).fetch` can serve as the provider's `fetch` (see `src/tests/react.test.ts`). Triggers in a test database: `pglite.exec(liveMigration({ app, tables }).up)` (there is no `applyLiveTriggers`: `/testing` loads with no peer).
8. Library files: `src/client.ts`, `src/react.ts`.

## Rules that bite

- Read only through `context.liveRead` inside a `liveRead` handler; the root `db` is another snapshot.
- `snapshot(tx, ...)` is refused (types and E001): pass the root database.
- A `liveRead` select typed `(context: Deps)` fails when `db` is `entrypointOnly`: type it with the handler context.
- Never reuse an epoch: a custom `epoch()` must return a new 12-character `[a-z0-9]` value each call (E001 otherwise).
- A stream that falls `subscriberFrames` behind gets `bye`; reconnect with the cursor.
- Never evict replay hints by count or make resume depend on what happened since a cursor: hidden-table hints would leak. Never filter by grant after a stream's window or queue: a hidden write would then change its timing or cause its `bye`. Resume or reset depends on the cursor's age only; the `replayEnvelopes` and `replayBytes` caps start a new epoch for everyone.
- Never make a trigger function `SECURITY DEFINER`: hint payloads travel over NOTIFY and any role that can connect may LISTEN, so a definer would publish keys its caller cannot read. Under row-level security the TRUNCATE trigger sends an overflow (every client resets).
- A scoped table without a grant for its dimension shows nothing; a key not normalized by `normalizeKey` never matches. Keys never reach a client outside its grant, so they need no HMAC.
- Never declare `live()` on a per-request table (sessions, counters): it refetches on every request. Do declare auth tables the answer depends on (memberships, roles).
- Shortcuts that break the guarantee: the root `db` inside a `liveRead` handler, DDL at boot, reads on a replica.
- Never parse or build a cursor: it is sealed. A cursor the hub cannot open resets; a malformed one is a 400.
- The hub needs `crypto.subtle`: `start()` rejects with E001 without it (bare Hermes, a browser page that is not a secure context). So does `liveReceipts()`, which throws E001 at once, also for a secret under 32 characters.
- The receipts secret comes from the app config, the same on every instance (`openssl rand -base64 32`). Never put a raw txid on the wire or in a mutation's response.
- `useLiveQuery` on a procedure that is not in the manifest never refreshes; the provider logs E001 once. Mutations get query utils from oRPC too, so the types cannot catch it.
- Pass a `headers` function; a new one only matters after a 401/403 (the provider then tries again).
- Hints say only which table (and which granted keys) changed. Every refetch is authorized by its own procedure.

## Errors

| Code             | Meaning                                                                                                                                                                                            | What to do                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `ARKI_LIVE_E001` | Bad meta or options, `liveRead()` without live meta, `snapshot()` given a `tx`, a repeated epoch, no WebCrypto, a hook outside `LiveProvider`, a second provider, a hook path not in the manifest. | Fix the declaration; see `remediation`. |
| `ARKI_LIVE_E002` | Missing, disabled or incompatible triggers.                                                                                                                                                        | Apply the live migration.               |
| `ARKI_LIVE_E003` | The hub is not ready.                                                                                                                                                                              | Retry with backoff.                     |
| `ARKI_LIVE_E004` | A malformed cursor, frame or payload.                                                                                                                                                              | Send back cursors exactly as received.  |
| `ARKI_LIVE_E005` | 401/403 on the stream.                                                                                                                                                                             | Re-authenticate.                        |
| `ARKI_LIVE_E006` | A bounded resource was reached; `awaitTxId` or `waitForInvalidation` timed out.                                                                                                                    | Reconnect; check the limits.            |

## Verify

```sh
bun run build
bun run typecheck
bun run test
bun run lint
bun run test:docs
bun run test:runtimes -- --require-all   # Hermes needs HERMES_BIN
bun run test:peers                      # every entry with its optional peers absent
bun run test:pack                       # the tarball
bun run test:e2e                        # Playwright on the Start fixture (Docker)
../../node_modules/.bin/arki-bench list # the benchmark cases and contracts, nothing timed

# In an app that mounts liveQueries: each live procedure with its tables, then the booted app's health.
dot explain --json | jq '.data.actions[] | select(.meta.meta.live) | {id, reads: .meta.meta.live.reads}'
dot doctor --json | jq '.data'
```
