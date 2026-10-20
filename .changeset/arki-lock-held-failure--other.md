---
'@arki/schedule': minor
---

A busy lock is now the `LockHeld` failure from `@arki/failure` (code `lock.held`, status 409), returned, never thrown. Its data is `waitedMs` (0 for the one-attempt verbs) and, only when `createLocks` got `logKeys: true`, the full `key`. `tryRun(fn)` returns the value of `fn` or `LockHeld`: the `{ ran, value }` wrapper and the `LockRun` type are gone. `tryAcquire()` returns a `Guard` or `LockHeld` (was `undefined`). `run(fn, { wait })` and `acquire({ wait })` return `LockHeld` when the lock is still busy after the wait (they threw `LockError` code `held`). The `held` code (`ARKI_LOCK_E001`) is removed from `LockError`; `aborted`, `lost`, `store`, `release`, `config` and `unsupported` stay thrown. Check a result with `LockHeld.is(result)`. `@arki/schedule`'s `Locker` port follows: `tryRun` returns the value or a `lock.held` failure (`LockerRun<T>` is `T | Failure<'lock.held'>`).
