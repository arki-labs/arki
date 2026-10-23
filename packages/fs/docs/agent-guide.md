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
5. **Upload from the client** with `uploadFile(orpc.files, blob, { onProgress })` from `@arki/fs/files`.
   Save the returned `record.id` (a `FileId`) on your own row.
6. **Schedule the sweep**: a `defineSchedule({ name: 'files.cleanup', every: '15m', handler })` whose handler
   loops `storage.cleanupOrphans()` while `more` (about 60 s budget), with `lock: { key: 'files.cleanup', locks }`.

## Traps

- **Store the `FileId`, never a URL.** URLs expire (300 s by default). Call `storage.url` when you render.
- **Expected outcomes are returned, not thrown.** `confirmUpload` returns `UploadPending` while the PUT is still
  running, and every call returns `FileUnavailable` for a file that is missing or not yours. Check
  `isFailure(result)` and return the failure on; `filesRouter` already sends them as declared oRPC errors.
- **Never mark a file ready from client success.** Only `confirmUpload` does, after it has read the object.
- **Never use `exists()` or an ETag as proof.** `exists()` answers `false` on any error; ETags differ by store.
- **Never call storage I/O inside a database transaction.** A rolled-back insert would leave a live URL with
  no row; a delete inside a transaction removes bytes before the commit. There is no `withTx` on purpose.
- **Emit "file attached" after `confirmUpload` returns**, not in the same transaction. For a business delete,
  call `storage.remove` from a journal effect after commit; the sweep covers a late effect.
- **Do not use the local adapter for uploads.** `fileStorage` refuses it. Use MinIO or a dev R2 bucket.

## Recovering stuck `deleting` rows

A `deleting` row is retried by every sweep after its `cleanup_at`, with backoff from 1 minute up to 1 day
(`cleanup_attempts` counts tries). Look at the WARN logs of `arki:fs` for the store error. Once the store is
fixed, make the rows due now and run one sweep:

```sql
update files set cleanup_at = now() where status = 'deleting';
```

Never set a `deleting` row back to `ready`: its object may already be gone.
