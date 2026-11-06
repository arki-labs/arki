# Agent guide: @arki/fs

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, the entry files named in `package.json` `exports` win.

## The model

1. Storage adapters (`createS3StorageAdapter`, `createR2Storage`, `createLocalStorageAdapter`) put, get, list and delete objects. The S3 and R2 adapters sign uploads. The local one cannot.
2. The files table (`filesTable`, `fileStorage`) is a Postgres or SQLite table. A row exists before any byte is written, and the server derives every key from the row.
3. The flow is `createUpload`, then a PUT to the signed URL, then `confirmUpload`, then `url`, then `remove`. Every call takes the acting owner id first.
4. A row is `ready` only after the server read the stored object and size and type matched. The sweep (`cleanupOrphans`) removes expired pending rows and every `deleting` row.
5. Expected outcomes are returned failures from `@arki/failure`: `FileUnavailable`, `UploadPending`, `FileWrongState`, `UploadMismatch`, and the `Storage*` failures. Only static bad configuration throws `FileStorageError`.
6. `@arki/fs/orpc` mounts the four procedures contract-first. `@arki/fs/testing` has `memoryUploadAdapter` for tests.

## Task map

### Add file uploads to a Dot feature

Six steps. The full, typechecked wiring is in `examples/files/server.ts` and `examples/files/client.ts`.

1. **Declare the owner id** in the feature's browser-safe ids module: `export const userId = defineId('usr_')`
   (or reuse the app's existing declaration). A workspace id works too: the owner type is generic.
2. **Add the table** to the server schema: `export const files = filesTable(pgColumns(), { owner: userId })`
   with `pgColumns` from `@arki/db/pg` and `filesTable` from `@arki/fs/pg`, then run `drizzle-kit generate`
   and commit the migration. One table per app. On SQLite (libSQL), use `sqliteColumns()` from
   `@arki/db/sqlite` and import everything from `@arki/fs/sqlite` instead.
3. **Build the storage once** in the feature's `.infra()` step:
   `fileStorage(db, createR2Storage({ ... }), { files, bucket: 'uploads', limits: { maxSize, allowedMime } })`.
   Pass the root database. Usecases ask for the storage like any service.
4. **Mount the procedures**: add `files: filesContract` (from `@arki/fs/orpc`) to the app contract, and
   `files: filesRouter(implementer.files, { storage: () => storage, actor: ctx => ctx.userId })` to the router.
   Throw `ORPCError('UNAUTHORIZED')` in `actor` when there is no user.
5. **Upload from the client** with `uploadFile(filesUploadClient(orpc.files), blob, { onProgress })` from `@arki/fs/files`.
   Import `filesUploadClient` from `@arki/fs/orpc`; check `isFailure(record)` before saving `record.id`.
6. **Schedule the sweep**: a `defineSchedule({ name: 'files.cleanup', every: '15m', handler })` whose handler
   loops `storage.cleanupOrphans()` while `more` (about 60 s budget), with `lock: { key: 'files.cleanup', locks }`.

## Rules that bite

- **Store the `FileId`, never a URL.** URLs expire (300 s by default). Call `storage.url` when you render.
- **Expected outcomes are returned, not thrown.** `confirmUpload` returns `UploadPending` while the PUT is still
  running, and every call returns `FileUnavailable` for a file that is missing or not yours. Check
  `isFailure(result)` and return the failure on; `filesRouter` already sends them as declared oRPC errors.
- **Never mark a file ready from client success.** Only `confirmUpload` does, after it has read the object.
- **Never use `exists()` or an ETag as proof.** `exists()` returns failures on backend refusal/outage; only missing objects return `false`. ETags differ by store.
- **Never call storage I/O inside a database transaction.** A rolled-back insert would leave a live URL with
  no row; a delete inside a transaction removes bytes before the commit. There is no `withTx` on purpose.
- **Emit "file attached" after `confirmUpload` returns**, not in the same transaction. For a business delete,
  call `storage.remove` from a journal effect after commit; the sweep covers a late effect.
- **Do not use the local adapter for uploads.** `fileStorage` refuses it. Use MinIO or a dev R2 bucket.

## Errors

| Code                  | Meaning                                                                                                           | What to do                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `fs.file_unavailable` | Missing, not yours, another bucket binding, or the policy refused.                                                | Show a placeholder. Do not probe which case it was. |
| `fs.upload_pending`   | The PUT has not landed yet.                                                                                       | Confirm again later.                                |
| `fs.file_wrong_state` | Not ready, being deleted, or the confirm window passed.                                                           | Start a new upload.                                 |
| `fs.upload_mismatch`  | Stored size, type or hash differs from the request. The row is now deleting.                                      | Upload again.                                       |
| `ARKI_FS_E001`        | `FileStorageError`: bad input or configuration (TTL over the cap, size over the limit, MIME not allowed). Thrown. | Correct the value to fit the configured limits.     |
| `ARKI_FS_E006`        | `FileStorageError`: the adapter cannot sign uploads (the local adapter given to `fileStorage`). Thrown.           | Use S3, R2 or MinIO.                                |

Storage calls also return `StorageUnavailable`, `StorageRejected`, `StorageWriteUncertain`, `StorageCancelled` and `StorageNotFound`. Reconcile `StorageWriteUncertain` before any retry. The README lists them under Failure behaviour.

## Recovering stuck `deleting` rows

A `deleting` row is retried by every sweep after its `cleanup_at`, with backoff from 1 minute up to 1 day
(`cleanup_attempts` counts tries). Inspect the returned canonical failure and its private cause in the owning supervisor. Once the store is
fixed, make the rows due now and run one sweep:

```sql
update files set cleanup_at = now() where status = 'deleting';
```

Never set a `deleting` row back to `ready`: its object may already be gone.

## Owned outcomes and telemetry

The README lists canonical read/write/uncertain/cancel outcomes and the explicit native foreign bridges.
`StorageWriteUncertain` always requires reconciliation before replay. A failed cleanup claim or deletion
returns a failure while its durable row remains responsible; successful cleanup has `failed: 0`.
SQL and object-store I/O remain outside each other's transactions. Unknown policy/progress faults are
supervised as `UnexpectedDefect`; no provider fault turns into absence.

Local keys cannot escape through dot segments or descendant symlinks. Keep the canonical base directory
application-owned; concurrent hostile ancestor replacement is outside the portable adapter's guarantee.
`readFirstLine` owns errors, empty EOF and cancellation; `readFile`, `writeToTheFileEnd`, `deleteAsync`,
`deleteSync`, `glob`, `globIterate` and `globStream` return typed storage failures too. `globIterate` ends
by returning its failure; `globStream` sends it as the last chunk.

Default spans/counters/durations use `@arki/fs` and bounded operation/failure codes. No private attributes
or global SDK configuration. Pure declarations and the in-memory testing adapter need no separate spans.
Run `bun run test`, `bun run typecheck`, `bun run build`, and `bun run lint`; run `test:pg` against owned
Docker Postgres and `test:live` only with an explicit disposable `ARKI_FS_LIVE_*` bucket. Missing provider
configuration is a blocker, not a green adapter result.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:pg
bun ../../tooling/library/src/llms.ts --check
```

`test:pg` needs owned Docker Postgres. Run `test:live` only with a disposable `ARKI_FS_LIVE_*` bucket.
