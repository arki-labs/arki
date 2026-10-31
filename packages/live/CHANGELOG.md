# @arki/live

## 0.2.0

### Minor Changes

- f3c95a0: `parseLiveEvent` and `parseLiveCursor` return a `schema.invalid_input` failure for a bad value instead of `undefined`. `awaitTxId` resolves a `live.receipt_timeout` failure on timeout instead of rejecting with E006 (`ReceiptTimeout` is exported). `touch()` falls back to a table-wide hint for a bad row key instead of throwing inside the caller's transaction. The client logs the error of a throwing `onEvent` on every failed attempt. `@arki/failure` is now a dependency.
- df6fa72: The documented `liveRead` one-liner now binds the readers through a usecase that takes the transaction (`snapshot(ctx.db, tx => ctx.usecases.readers(tx))`), because a request handler no longer reads infra.

### Patch Changes

- 440c75f: Dot's kernel atom is now a **unit**, and its constructor says its role. Breaking (0.x, so a minor):

  - The builder has three steps, always in this order: `defineApp(name).infra(...).features([...]).entrypoints(...)`. `.use()`, `.useAll()` and `.serve()` are removed: write `.use(x)` as `.infra(x)`, `.useAll(list)` as `.infra(...list)`, and `.serve(x)` as `.entrypoints(x)`. `.infra(a, b)` checks the list in order, like separate calls.
  - `plugin({...})` → `infra({...})` for infrastructure (a database, a cache, a mailer, an outside client). `.infra(...)` mounts it.
  - A unit served from `.entrypoints(...)` is now `entrypoint({...})`.
  - `driven(features => plugin({...}))` → `infra.fromFeatures(features => unit({...}))`; `driver(features => plugin({...}))` → `entrypoint.fromFeatures(features => unit({...}))`. `unit({...})` is the role-less atom and belongs only inside `fromFeatures`.
  - `@arki/dot/plugin` → `@arki/dot/unit`. Every `Plugin*` type is now `Unit*` (`Unit`, `AnyUnit`, `UnitNeeds`, `UnitPhases`, ...); `Driver` / `Driven` → `EntrypointBinder` / `InfraBinder`; `DotPluginError` → `DotUnitError`; `testPlugin` → `testUnit`; `initPlugins` → `initUnits` (its factory method `.plugin` → `.infra`); a feature's `.plugins()` → `.units()`; the context key `$plugin` → `$unit`.
  - `UnitRole` is `'infra' | 'feature' | 'entrypoint'` (was `'feature' | 'driving'`, with infra unlabelled). Every mounted unit has a role, and the manifest shows it.
  - The builder checks the side: `.infra()` refuses an entrypoint, and `.entrypoints()` refuses an infra or feature unit, at compile time. An erased graph fails `configure()` with the new `ARKI_DOT_E033` (`DotLifecycleErrorCode.UnitOnWrongSide`).
  - OpenTelemetry attributes: `dot.plugin.*` → `dot.unit.*` and `dot.app.plugin.count` → `dot.app.unit.count`. Update dashboards and alerts that query them.
  - `dot explain --graph` groups the hexagon as `infra` / `features` / `entrypoints`.
  - Domain logic with no usecases is still a feature: `defineFeature('orders').needs({...}).provides({...}).entrypoints()`. The quickstart now teaches this shape.

  Not yet renamed: the manifest and diagnostics JSON keys (`plugins`, `plugin`, `registeringPlugin`). A follow-up renames them. `@arki/dot/plugin` and `plugin` stay as aliases of `@arki/dot/unit` and `infra` inside the monorepo until then, and will be removed before this ships.

  The adapters move to the new names and the new steps (`@arki/tanstack-start`'s `tanstackStart(...)` is now built with `entrypoint`, so it mounts only with `.entrypoints(...)`, as before).

  demo impact: drop-studio's and faultline's Dot code uses `plugin(...)` and `@arki/dot/plugin`; rename on their next upgrade.

- e132ad3: Object checks on unknown values now use `is(value, recordSchema)` from `@arki/schema` instead of hand-written `typeof value === 'object'` guards. Behaviour is unchanged.
- 36b4da8: Auth checks are plain steps (RFC `docs/rfcs/2026-10-21-dot-middleware.md`, step 4).

  - `@arki/auth` adds `authed`, `verified` and `role(name)`: plain functions that read `ctx.principal` and narrow it to non-null, or refuse with `auth.unauthenticated` (401) / `auth.forbidden` (403). Attach them with the transport's `step()`: `impl.x.use(step(authed))` (`@arki/dot/orpc`), `routes().use(step(authed))` (`@arki/http`). The handler keeps the app's own principal type.
  - `@arki/auth/http` adds `principalFromHeaders(auth)`, a step that adds `principal` (`null` for a guest) from the request's credentials.
  - Breaking: `guards<C>()` is removed from `@arki/auth/orpc`. `const { authed } = guards<C>()` → `import { authed } from '@arki/auth'` and `.use(step(authed))`. `can(policies)(name, load)` is now imported directly from `@arki/auth/orpc`, same call shape.
  - Breaking: `withPrincipal(auth, options)` and `withOptionalPrincipal(auth)` are removed from `@arki/auth/http`. Use `.use(step(principalFromHeaders(auth), { failureHeaders: authFailureHeaders }))`, then `.use(step(authed, { failureHeaders: authFailureHeaders }))` (or `verified`, `role(name)`) on routes that need a signed-in caller.
  - Breaking: `@arki/http` removes `derive(key, fn)`, the bundle's `.derive()`, `Deriver`, `ErasedDeriver`, `BASE_CTX_KEYS` and `ARKI_HTTP_E007`. A keyed deriver becomes a step that returns an object: `.derive('db', fn)` → `.use(step(ctx => ({ db: fn(ctx) })))`. `verifyWebhook({ scheme })` is a step: `.use(step(verifyWebhook({ scheme })))` adds `ctx.webhook`. A route bundle's `derivers` field is renamed `stages` (it holds steps and arounds).
  - Fix: `@arki/http` steps after the first one see `ctx.url` and `ctx.signal` again (they were dropped when the context was extended). This fixes `@arki/live`'s endpoint, which reads `ctx.url` in its second stage.

- Updated dependencies [5d55e12]
- Updated dependencies [a905468]
- Updated dependencies [c36e614]
- Updated dependencies [b992897]
- Updated dependencies [289ba73]
- Updated dependencies [ebc681b]
- Updated dependencies [6cc8655]
- Updated dependencies [440c75f]
- Updated dependencies [5d55e12]
- Updated dependencies [be8f8e2]
- Updated dependencies [c3e63ba]
- Updated dependencies [e132ad3]
- Updated dependencies [1e47612]
- Updated dependencies [e132ad3]
- Updated dependencies [49517e2]
- Updated dependencies [29520c1]
- Updated dependencies [8944628]
- Updated dependencies [88daaeb]
- Updated dependencies [b37115d]
- Updated dependencies [36b4da8]
- Updated dependencies [c1ed2a3]
- Updated dependencies [5d55e12]
- Updated dependencies [b435e76]
- Updated dependencies [517d297]
- Updated dependencies [1a897f8]
- Updated dependencies [9d408cf]
- Updated dependencies [e80211d]
- Updated dependencies [17e86d3]
  - @arki/http@0.4.0
  - @arki/db@0.5.0
  - @arki/dot@0.9.0
  - @arki/resilience@0.3.1

## 0.1.0

### Minor Changes

- 2d91f1c: Scoped hints, server half: a table can be scoped by a key column, and a write then reaches only the streams granted that key.

  - `liveScopes({ org: [[posts, posts.orgId]], user: [[memberships, memberships.userId]] })` from `@arki/live/drizzle` declares the scoped tables. Dimension names come from the object's keys; each key kind (`uuid`, `text`, `int`) from the column type. A nullable column, a column of another table, a table in two dimensions, mixed key kinds in one dimension or another column type is E001.
  - `live({ reads, scope: { org: 'input.orgId' } })` (or `'session'`, or `'input'`) puts where a procedure's key comes from into its meta. `liveManifest(contract, { scopes })` checks each dimension exists and each input path is in the procedure's input schema (E001 otherwise), and adds the key kind to manifest entries.
  - `liveMigration({ app, tables, scopes, maxKeys })`: a scoped table gets AFTER INSERT, UPDATE and DELETE statement triggers with transition tables (`arki_live.notify_keys_v1`), one NOTIFY per distinct key, and a BEFORE TRUNCATE trigger (`arki_live.notify_truncate_v1`, SECURITY INVOKER: it reads the keys with the truncating role's rights, and sends an overflow instead when row-level security applies to that role or it cannot read the key column). Identical NOTIFYs fold, so each (table, key) is hinted once per transaction. A statement past `maxKeys` (65 536) distinct keys, or with a key past 512 bytes, sends one overflow: every client resets, and the write commits. The migration fails unless the key column exists and is NOT NULL; a table that becomes scoped loses its unscoped trigger. Partitions in `leaves` get the same triggers. Unscoped tables keep the old trigger and payload.
  - `verifyLiveTriggers(db, { app, tables, scopes, maxKeys })` checks the four triggers (function, events, transition tables, arguments), the key column (`missing-column`, `nullable-column`), and every partition of a partitioned table, partitioned partitions included.
  - `touch(tx, { app, scopes }, { schema, table, keys })` publishes keys; with `scopes`, a scoped tag without keys is E001 and keys are written the way Postgres prints them.
  - `pgSource` reads keyed hints and turns an overflow into `gap` then `ready`.
  - The hub keeps one envelope per transaction (with each table's keys), and each stream projects every envelope through its view by (table, key) before its batch window, queue and split. `hub.open({ view })` takes `{ tables?, scopes?: [{ tag, name, keys: string[] | 'all' }] }`. A frame's tag names `scope: { name, keys }` with only the stream's own keys; frames split at 256 tags or 1024 keys.

  Breaking (0.x): `hub.open({ grant })` is now `hub.open({ view })` (`LiveView`); `limits.replayFrames` is replaced by `replayEnvelopes` (default 262 144) and `replayBytes` (default 64 MiB); `LiveSourceEvent.change` tags may carry `keys`; `LiveMeta.live.scope`, manifest `scope`, `hello.scopes` and `change.tags[i].scope` are new wire fields. New: `liveScopes`, `LiveScopes`, `LiveScopedTable`, `LiveKeyKind`, `LiveView`; `LiveTriggerProblem` gains `missing-column` and `nullable-column`.

- a14112e: Scoped hints, endpoint and client half: grants carry keys per dimension, memberships re-authorize a stream, and the client refetches only the queries of the changed keys.

  - `liveEndpoint({ hub, manifest, scopes, authorize, reauthorize })`: `authorize` returns `LiveGrant<D>`, `{ tables?, scopes?: { org?: string[] | 'all' } }`, typed by the dimensions of `scopes`. The endpoint builds the stream's `LiveView` from it: per scoped table its dimension and the granted keys, normalized the way Postgres prints the key kind, or `'all'`. A dimension the grant leaves out shows nothing (closed by default). A procedure reading a scoped table stays in the client's manifest when the grant has `'all'` for that dimension, or has keys and the procedure declares `scope` for it; otherwise it is left out, and the endpoint warns once (E001). An undeclared dimension, a key of the wrong kind or over 4 096 keys per dimension is E001.
  - `hello.scopes` names the stream's own granted keys.
  - `reauthorize: [tableTag(memberships)]`: a frame naming one of these tables runs `authorize` again before it goes out. When the grant changed, or `authorize` refuses or throws, the stream sends `bye` instead, and the client resumes from its last cursor under the new grant. Its tables join the endpoint's tables (they need triggers too).
  - `liveQueries` (Dot) takes `scopes`, `reauthorize` and `maxKeys`, and checks the triggers of the scoped and `reauthorize` tables at boot.
  - `LiveProvider`: a scoped tag refetches only the queries whose input holds a changed key at the declared path (any form Postgres reads, so an upper-case UUID matches; an input without the key refetches too); a `'session'` path refetches whole. On a `hello` that grants fewer keys, the queries of lost keys are removed from the cache (a `'session'` path whole); on a resume, the queries of gained keys refetch.
  - Security: `arki_live.notify_truncate_v1` is now SECURITY INVOKER. Hint payloads travel over NOTIFY, and any role that can connect may LISTEN on any channel, so no trigger publishes a key its caller cannot read. TRUNCATE of a scoped table under row-level security for the truncating role, or by a role that cannot read the key column, sends one overflow: every client resets. Re-run the live migration to replace the function.
  - Benchmarks: a scoped-hints strategy (per-tenant grants through the real hub; the run fails above 3.0 origin queries per commit or on a cross-tenant fetch) and a writer group over 1, 1 000 and 100 000 rows with scoped triggers.

  Breaking (0.x): `LiveGrant` gains a type parameter and `scopes`; `liveEndpoint` and `liveQueries` take `scopes`; a grant without a dimension no longer sees keyed hints of tables scoped by it.

  Follow-up:

  - `reauthorize` no longer fails open. The endpoint watches writes to `reauthorize` tables through the new `hub.onChange(listener)` (the hub's changes before any view; server-side only), so a stream whose grant cannot see the table is re-checked too. A write scoped by the principal's dimension re-checks only the streams whose grant holds its key; otherwise every stream. The re-check runs `authorize` silently, once per burst, and the stream's frames wait for it; an unchanged view gets nothing, a changed view sends `bye`, and a refusal or a throwing `authorize` ends the stream with `bye` (fail closed).
  - Benchmarks: the scoped-trigger cost moves from a timed unit test to a bench group (`writer-insert-one-row`, a one-row insert into a 20 000-row table); the test suite now checks only that a one-row write names its own keys on a full table.
  - `LiveEndpoint.close()` (new): releases the endpoint's `hub.onChange` subscription and ends its open streams with `bye`. Call it before rebuilding an endpoint on the same hub (hot reload); `liveQueries` calls it on stop and on a rolled-back start, so no listener piles up.

- fa1ddc6: Live queries milestone M3: the client.

  - **Opaque cursors (breaking).** A cursor is no longer `${epoch}.${seq}`: the hub seals its position with AES-GCM under a key it makes at `start()`, with a fresh IV every time, so a client cannot count the frames its grant hides. Cursors are 64 base64url characters; `parseLiveCursor` checks only that shape. A well-formed cursor the hub cannot open resets (it is not a 400). The hub needs WebCrypto (`crypto.subtle`); `start()` rejects with E001 without it.
  - **Hub (breaking).** `LiveHub.open()` now returns a promise (it opens the cursor first). New `hub.cursor()`: the current position as a new cursor, for a server-rendered page to dehydrate.
  - **`createLiveClient`** in `@arki/live`: `fetch` + streaming body + streaming `TextDecoder`, framed by hand (split chunks and code points, CR/LF, `:keepalive`, `event: error`); `bye` reconnects at once with the cursor, `gap` and errors back off (250 ms to 10 s, jittered; a 503 waits its `retry-after`), 401/403 stop as `unauthorized`, 400 drops the cursor, a fetch without a streaming body fails loud (E004). New types `LiveClient`, `LiveClientOptions`, `LiveStatus`.
  - **`@arki/live/react`** (new entry): `LiveProvider`, `useLiveQuery(orpc.x.queryOptions({ input }))`, `useLiveStatus`, `setLiveCursor` (server rendering resumes from the hub cursor instead of resetting) and `awaitTxId(queryClient, txid, { timeoutMs })`. A hint during a query's first fetch is not lost (one trailing refetch); 401/403 is not retried and resets a query once, with no refetch loop; `initialData` is a type error; paths that leave the manifest are dropped from the cache; a hook on a procedure not in the manifest logs E001 once.
  - **`@arki/live/testing`**: `waitForInvalidation(queryClient, path, timeoutMs?)`.

- 15fedf2: Live queries M2: hub, endpoint, Dot. `@arki/live/http` adds `liveEndpoint`, the `GET /api/live` server-sent-events stream: a bad cursor (400 E004), a refused `authorize` (401 E005) and a hub without its listener (503 E003, `retry-after`) are answered before any stream header; `hello` carries the part of the manifest the grant allows; `change` frames keep only granted tables and only the txids of transactions that wrote one of them, and a frame with none is skipped whole, so a client cannot see writes on tables it cannot read; after `maxAgeMs` (5 minutes) the stream sends `bye`. `@arki/live/dot` adds `liveQueries`, a Dot plugin that verifies triggers at boot (E002), listens at start, releases the listen client on stop or rollback, and publishes `live` and `liveRoutes`. `@arki/live/orpc` adds `liveManifest` (nested routers; procedures without live meta skipped; bad meta is E001) and `@arki/live` adds `liveTables`. The hub's `stop()` now settles once for every caller and only after the source stopped, also while `start()` is still running; a stopped hub refuses `start()`. New optional peers: `@arki/http`, `@arki/dot`. Each `change` frame now names exactly the transactions that wrote its own tables (before: the whole batch, on its last frame); the hub's feed adds `txidsByTag` for filtering. Breaking: the Zod schemas are no longer exported. `@arki/live` exports plain types (`TableTag`, `LiveMeta`, `LiveManifest`, `LiveCursor`, `LiveEvent`, `LiveLimits`) and the runtime checks `parseLiveEvent` and `parseLiveCursor`, so no public type ties a consumer to Zod.
- 9281865: `listenOnPool` moves from `@arki/journal` to `@arki/db/pg`, with `ListenClient`, `ListenPool`, `ListenOptions` and `unrefTimer`. **Breaking for `@arki/journal`:** it no longer exports `listenOnPool`, `ListenClient` or `ListenPool`; import them from `@arki/db/pg`. `journal.worker(db, { listen })` is unchanged. The listener now also handles an `end` without an error, runs a `select 1` health check every `healthMs` (default 5000; no answer by the next check drops the client), reports `onState('ready' | 'disconnected')`, releases a lost client exactly once, and forwards nothing from a released client. `ListenClient` gains `on('end')`. `@arki/db` no longer has a dev dependency on `@arki/journal`; the two tests that used both now live in `@arki/journal`.

  `@arki/live/pg` (milestone M1): `liveMigration` generates the reviewable trigger SQL (statement triggers that publish `{ v: 1, tag }` at commit; partition leaves publish their root), `liveChannel`, `verifyLiveTriggers` lists every table that would not publish (missing, disabled or replica-only, wrong function, events or arguments, uncovered partition leaf), `touch` publishes tags from inside a transaction, and `pgSource` is the hub's source on a `pg` pool: `ready` only after `LISTEN`, `gap` on a lost listener or an unreadable payload. Each hint carries the committing transaction's id (`txid`, `pg_current_xact_id()` as a decimal string), and the hub's `change` frame now has `txids` (strict schema change). The generated SQL splits statements with `--> statement-breakpoint`, so Drizzle's migrator runs it on PGlite too. `@arki/db` is a new optional peer.

- c1f24ee: M4: failure matrix, benchmarks and docs, with three behaviour changes. **Resume or reset now depends on a cursor's age alone** (`replayMs`): the replay ring evicts by age only, so writes to tables a client cannot see no longer turn its resume into a reset. `limits.replayFrames` (default 65 536, was 4096) is now a hard overload cap: reaching it starts a new epoch, ends every stream with `gap` and resets every client together, logged at warn. Cursors seal the position's time and grow from 64 to 75 characters (still opaque; still accepted by `parseLiveCursor`). **A `change` frame is sealed once** and its cursor shared by every stream (one AES-GCM call per frame instead of per client). **The client drops a silent connection**: no byte for 35 s (two missed heartbeats) or a browser `offline` event ends the stream and reconnects with the cursor, so a half-open connection no longer stays `live`. Also: the Postgres failure suite (16 and 18) and session tests, a Playwright run on a TanStack Start fixture, `test:peers` and `test:pack` checks, `bench/live.bench.ts` (numbers pending an idle run), a compiled Dot example, and README sections on write paths, security, operations, account switches and when to pick Electric, Zero or PowerSync instead.
- 8e34d02: New package: live queries on your own Postgres, milestone M0 (correctness and type proof). `@arki/live` has the wire schemas (`tableTagSchema`, `liveMetaSchema`, `liveManifestSchema`, `liveCursorSchema`, `liveEventSchema`), `live()` meta from tags, `affectedPaths`, `LIVE_ERROR_CODES`, and the portable hub `createLiveHub`: hints are batched into numbered frames per random epoch, a bounded replay ring lets a reconnect resume, and everything else (no cursor, another epoch, an evicted cursor, a listener gap) resets. `@arki/live/drizzle` adds `live()` from Drizzle tables, `tableTag` and `snapshot()` (one `REPEATABLE READ READ ONLY` transaction per call; a `tx` handle is refused). `@arki/live/orpc` adds `liveRead()`, the middleware that runs a live procedure inside one snapshot and puts the readers on `context.liveRead`. `@arki/live/testing` adds `fakeSource()`.
- d166e0c: Two leaks fixed, before the scoped-hints work.

  - The grant now applies inside the hub, before each stream's own batch window, queue and frame split. `liveEndpoint` passes it as `hub.open({ grant })`. A hint with no granted table no longer reaches the stream at all, so hidden writes can no longer cause a slow client's `bye`, change its frame count, close its window early (the 256-transaction flush) or shift when its frames arrive. Each stream now batches its own visible hints; a resume replays the missed hints through the same grant and windows. The ring holds one hint per source change, and the `replayFrames` default is now 262 144.
  - Frames carry receipts instead of raw Postgres transaction ids, which showed the database-wide write volume. `liveReceipts({ app, secret })` makes `base64url(HMAC-SHA256(secret, "arki-live/v1|" + app + "|" + xid8))` cut to 22 characters; pass it as `createLiveHub({ receipts })` (or `liveQueries({ receipts })`) and return `await receipts.of(txid)` from mutations. `awaitTxId(queryClient, receipt)` matches by equality as before. The secret comes from the app config (at least 32 characters, e.g. `openssl rand -base64 32`); `liveReceipts` throws E001 for a shorter one or without WebCrypto. Without `receipts`, frames carry `txids: []`.

  Breaking (0.x): the wire `change.txids` holds 22-character receipts (old clients reject the new frames); `LiveFeed`'s `change` loses `txidsByTag`; `LiveGrant` moves to the core (still exported from `@arki/live/http`). New: `liveReceipts`, `LiveReceipts`, `LiveReceipt`, `LiveGrant` from `@arki/live`, `open({ grant })`, `createLiveHub({ receipts })`, `liveQueries({ receipts })`.

### Patch Changes

- 260d77b: `@arki/live` now runs on Hermes (React Native). Hermes cannot compile async generators, so the client's SSE reader, the hub's stream feed and the endpoint's frame stream are now plain async iterators. They behave as before: calls run one at a time, and a stream that ends early (a last frame, an error, `return()` or `break`) still releases its body reader, its hub slot and its listeners. One small fix: a stream returned before it was ever read now cleans up too. No API change.

  no demo impact: internal iterator rewrite, no API change

- f43d509: Docs standard: AGENTS.md in the laws shape, CHANGELOG, README sections in the standard order (`When not to use this`, `Public imports`, `Failure behaviour`, `Limits` with the update ordering rules), and `@fix`/`@verify` notes on every error code.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

- abbf0f0: `reauthorize`: a write to a `reauthorize` table that lands while a stream opens (after its `authorize` read the grant, before the stream joins the endpoint's re-check list) now re-checks that stream before its first frame (`hello` included); before, the stream served the old grant until the next such write or `maxAgeMs`.

  `close()` now fails closed: a stream still opening when the endpoint closes ends at once instead of joining unwatched, and every open stream gets `bye` (as documented) so clients reconnect.

- Updated dependencies [5bc6390]
- Updated dependencies [cbefc52]
- Updated dependencies [7ce6a18]
- Updated dependencies [8b3cc80]
- Updated dependencies [5d05b9c]
- Updated dependencies [115aa87]
- Updated dependencies [8e55924]
- Updated dependencies [d471284]
- Updated dependencies [ddcc363]
- Updated dependencies [47d296b]
- Updated dependencies [f56ab9f]
- Updated dependencies [232d3e8]
- Updated dependencies [5e4c630]
- Updated dependencies [3064b6a]
- Updated dependencies [7ce6a18]
- Updated dependencies [3359639]
- Updated dependencies [af3d5a1]
- Updated dependencies [7c05d9a]
- Updated dependencies [28cd943]
- Updated dependencies [932c9e4]
- Updated dependencies [232d3e8]
- Updated dependencies [966efcd]
- Updated dependencies [cbefc52]
- Updated dependencies [953991a]
- Updated dependencies [f6a15d0]
- Updated dependencies [2c0b668]
- Updated dependencies [011ece7]
- Updated dependencies [71dea3e]
- Updated dependencies [9281865]
- Updated dependencies [49a339e]
- Updated dependencies [536d17d]
- Updated dependencies [b9ae16f]
- Updated dependencies [953991a]
- Updated dependencies [62ec96a]
- Updated dependencies [232d3e8]
- Updated dependencies [7b4b5bf]
- Updated dependencies [f2e9f69]
- Updated dependencies [d11c9fb]
- Updated dependencies [ee69f29]
- Updated dependencies [b9d0a86]
- Updated dependencies [fce3e8c]
- Updated dependencies [a1d4ee6]
- Updated dependencies [5bc6390]
- Updated dependencies [232d3e8]
- Updated dependencies [2ce7fe2]
- Updated dependencies [00519da]
- Updated dependencies [670554a]
  - @arki/db@0.4.0
  - @arki/http@0.3.0

## 0.0.0

Not published yet. The first release adds live queries on your own Postgres: wire schemas, the hub, `live()` meta, `snapshot()`, `liveRead()`, the Postgres source, the SSE endpoint, the Dot plugin, the stream client and the React provider.
