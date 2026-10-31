# @arki/lock

## 0.2.1

### Patch Changes

- Updated dependencies [fac706c]
- Updated dependencies [7be13e9]
  - @arki/dot@0.10.0

## 0.2.0

### Minor Changes

- 17827b1: New entry `@arki/lock/sqlite`: `sqliteLease(db, { ttl, table? })`, a lease store on SQLite with the `pgLease` model. Pass the `db` from `createLibsqlDb` (`@arki/db/libsql`) as it is; lock writes then take their turn in its write queue.

  - One row per key in `arki_lock`, never deleted, so the fence only grows. An acquire is one `INSERT … ON CONFLICT DO UPDATE … RETURNING`. Times are integer milliseconds from SQLite's clock.
  - Mutex and semaphore (holders in a JSON `text` column), `extend`, owner-checked `release`. Guarantees: lease, cluster, `fence: 'durable'`, `wait: 'poll'`.
  - `SQLITE_BUSY` from another process is "held right now" on acquire, never an error.
  - `ensureLockTable(db, table?)`, `LEASE_TABLE_SQL` and `leaseTableSql(name)` for the table.

- 40e21b4: Return canonical lock cancellation, backend, ownership-loss and release outcomes; preserve callback failure identity and supervise defects without replay. Add nominal resource/owner/fence identities, schema restoration, and default OpenTelemetry spans and bounded counters. Named stores, DDL and disposal own their operational failures. Schedule admits the exact canonical lock union and never treats provider failure as contention. Immediate application consumers propagate outcomes; native RPC and disposal protocols retain explicit typed bridges.

  Breaking: branch all failures before using a callback or guard result; parse low-level keys, owner tokens and fences through `@arki/lock/zod`. Manual release and extension return failures; successful-callback cleanup preserves the completed result and reports uncertainty. Leadership stops on callback failure, defect or lost ownership. Existing key bytes, fencing and late-grant return remain unchanged.

  Docs and examples describe the changed behavior. No demo impact: this package has no standalone demo application.

### Patch Changes

- 164e25a: `pgLease(...).dispose()` now returns a `lock.store` failure (method `dispose`) when the LISTEN connection cannot be released. Before, the error was swallowed and `dispose` resolved as if it had worked. No docs impact. No demo impact.
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

- 5d55e12: Remove Zod types from more public declarations, with no API change. `@arki/db`: `TransactionSettings` and `ResolvedTransactionSettings` are plain types, locked to their schema by an exact type test. `@arki/fs`: the `./pg` and `./sqlite` declarations no longer reach the wire schemas, and `UploadRequest` is a plain type with the same lock. `@arki/lock`: the table name schema is private to `pg/lease.sql`.

  No docs impact: no public name or behaviour changed. No demo impact: same reason.

- e132ad3: Hand-written object guards now come from `@arki/schema` (`is(value, recordSchema)` or `plainObjectSchema`), per A-39. Replaced: the `isRecord`/`isPlainObject`/`isObject` helpers in `dot`, `cli`, `http`, `expr`, `lock`, `mail`, `embeddings` (its internal `isRecord`, not a public export), `testing` and `payments`, plus inline `typeof x === 'object' && x !== null` checks on unknown values. Behaviour is the same, except that the inline checks and `lock`'s guard no longer let arrays through. `@arki/expr` and `@arki/lock` now depend on `@arki/schema`.
- 5d55e12: Docs only: `llms.txt` import paths list `./zod`. No code change.
- Updated dependencies [289ba73]
- Updated dependencies [c1ed2a3]
  - @arki/dot@0.9.0

## 0.1.0

### Minor Changes

- 469ec98: A busy lock is now the `LockHeld` failure from `@arki/failure` (code `lock.held`, status 409), returned, never thrown. Its data is `waitedMs` (0 for the one-attempt verbs) and, only when `createLocks` got `logKeys: true`, the full `key`. `tryRun(fn)` returns the value of `fn` or `LockHeld`: the `{ ran, value }` wrapper and the `LockRun` type are gone. `tryAcquire()` returns a `Guard` or `LockHeld` (was `undefined`). `run(fn, { wait })` and `acquire({ wait })` return `LockHeld` when the lock is still busy after the wait (they threw `LockError` code `held`). The `held` code (`ARKI_LOCK_E001`) is removed from `LockError`; `aborted`, `lost`, `store`, `release`, `config` and `unsupported` stay thrown. Check a result with `LockHeld.is(result)`. `@arki/schedule`'s `Locker` port follows: `tryRun` returns the value or a `lock.held` failure (`LockerRun<T>` is `T | Failure<'lock.held'>`).
- 232d3e8: Cursor encoding and decoding return canonical failures. Database pagination
  preserves those outcomes before building SQL or returning a page. Check codec
  results and declare the original cursor failures at RPC boundaries.

  Failure lint rules now catch discarded callback returns, nested aggregate and
  iterator results, and blind acceptance through aliases or generic failure guards.
  Handle each outcome or forward it to its owner.
  Browser contract linting admits canonical failure definitions while keeping
  exception bridges in implementations.
  The exported lock conformance suite now checks each queued task's acquisition
  outcome before accepting its completion counts.

  Dot acquires telemetry instruments inside guarded execution, so importing before
  SDK setup works and broken reporters cannot replace application outcomes.

### Patch Changes

- f43d509: Docs standard: AGENTS.md, an agent guide, llms.txt, CHANGELOG, a tested example, README sections in the standard order (`When not to use this`, `Limits`, `Failure behaviour`), a README test that matches the `LockHeld` return type, and `@fix`/`@verify` notes on every error code and on `LockHeld`.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

- 9192d0e: First release of `@arki/lock`: distributed locks and semaphores for TypeScript, with one API over memory, Postgres, Redis and file stores.

  - Verbs `tryRun`, `run`, `tryAcquire` and `acquire` on `mutex(key)`, `semaphore(key, { limit })` and `readWrite(key)`, plus `lead(fn)` leader election on lease stores. Contention is a value, never an error.
  - Stores: `memoryStore`, `pgSession` and `pgTransaction` (advisory locks), `pgLease` (a lease row with a durable fencing token), `redisStore` and `fileStore`. Each declares its guarantees, and the handle types follow them: a missing capability is a missing method.
  - Leases renew themselves, abort the callback's `signal` when ownership is lost, and take a bounded wait and `storeTimeout`. A failed release after a successful callback is logged and counted, not thrown.
  - `@arki/lock/dot` adds the `locks()` plugin, with a production guard against process-scope stores. `@arki/lock/testing` has a manual scheduler, a store conformance suite and a replica property.

## 0.0.0

Not published yet. The first release adds distributed locks and semaphores over memory, Postgres, Redis and file stores.
