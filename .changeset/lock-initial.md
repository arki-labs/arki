---
'@arki/lock': patch
---

First release of `@arki/lock`: distributed locks and semaphores for TypeScript, with one API over memory, Postgres, Redis and file stores.

- Verbs `tryRun`, `run`, `tryAcquire` and `acquire` on `mutex(key)`, `semaphore(key, { limit })` and `readWrite(key)`, plus `lead(fn)` leader election on lease stores. Contention is a value, never an error.
- Stores: `memoryStore`, `pgSession` and `pgTransaction` (advisory locks), `pgLease` (a lease row with a durable fencing token), `redisStore` and `fileStore`. Each declares its guarantees, and the handle types follow them: a missing capability is a missing method.
- Leases renew themselves, abort the callback's `signal` when ownership is lost, and take a bounded wait and `storeTimeout`. A failed release after a successful callback is logged and counted, not thrown.
- `@arki/lock/dot` adds the `locks()` plugin, with a production guard against process-scope stores. `@arki/lock/testing` has a manual scheduler, a store conformance suite and a replica property.
