# Typed response-cache writes

`IdempotencyRepository.store()` now returns `void | IdempotencyStoreFailure`.
Check `isFailure(result)` when calling it directly. The exact union comes from
`IDEMPOTENCY_STORE_FAILURES`: entropy availability, an unexpected generation
defect, or `IdempotencyStoreUnconfirmed` after a database write was attempted.

The middleware consumes these failures and logs a safe code. It returns the
completed handler's response. A cache failure never means the application
operation failed and never authorizes repeating it. An unconfirmed cache write
may already be durable; reconcile the cache before retrying that write.
No automatic retry was added. The existing concurrent replay race remains.

## Explicit record IDs

`idempotencyKeyId` defines the stored record identity once; `IdempotencyKeyId` is
inferred through `IdOf`. It is distinct from the client-supplied idempotency
token. New values retain `idk_` plus 21 characters from the URL-safe Nano ID
alphabet. Stored historical prefix-compatible values remain valid.

Both default and namespaced tables require an explicit ID for direct inserts:

```ts
import { isFailure } from '@arki/failure';
import { idempotencyKeyId, idempotencyKeys } from '@arki/offline/orpc';

const id = idempotencyKeyId.create();
if (isFailure(id)) return id;
await db.insert(idempotencyKeys).values({ ...record, id });
```

The table no longer runs a hidden entropy callback. The repository generates
before SQL and forwards the original failure object. There is no stored column
or index migration. Parse incoming raw record IDs with `idempotencyKeyId.schema`
at a validated boundary; do not cast strings into the brand.

## Instrumentation and remaining scope

Every repository cache-write attempt emits `offline.idempotency.store` through
the `@arki/offline` tracer. The span inherits active application context and
records only `failure.code` and an error status on failure. It does not record
tokens, user IDs, procedure paths, payloads or private causes. Configure an OTel
SDK in the application; the library never installs one. Context and reporter
faults cannot repeat a write or change its outcome.

This migration covers the record generator and cache-write boundary. Cache
reads, authorization middleware failures, browser mutation IDs and IndexedDB
boundaries remain separate migration work. In particular, `find()` still uses
its existing foreign database rejection protocol.
