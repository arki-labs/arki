# Agent guide: add file uploads to a Dot feature

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

## Traps

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
`readFirstLine` owns errors, empty EOF and cancellation; older synchronous `readFile` remains a separate
native-helper obligation.

Default spans/counters/durations use `@arki/fs` and bounded operation/failure codes. No private attributes
or global SDK configuration. Pure declarations and the in-memory testing adapter need no separate spans.
Run `bun run test`, `bun run typecheck`, `bun run build`, and `bun run lint`; run `test:pg` against owned
Docker Postgres and `test:live` only with an explicit disposable `ARKI_FS_LIVE_*` bucket. Missing provider
configuration is a blocker, not a green adapter result.
