# @arki/lock

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
