# @arki/fs

## 0.2.0

### Minor Changes

- 69c3240: The files table runs on SQLite (libSQL) as well as Postgres. `filesTable` is written once against the `@arki/db` column kit, and the new `@arki/fs/sqlite` entry has the same `filesTable`, `fileStorage`, sweep and types as `@arki/fs/pg`. On Postgres the DDL is unchanged, so no migration is needed.

  **Breaking:** `filesTable` takes the kit first, and the Postgres schema moves into it. Migrate each call:

  ```ts
  filesTable({ owner: userId, schema }); // before
  filesTable(pgColumns(schema), { owner: userId }); // after; pgColumns from '@arki/db/pg'
  ```

  On SQLite: `filesTable(sqliteColumns({ prefix? }), { owner })` from `@arki/db/sqlite`, and `fileStorage(db, adapter, options)` from `@arki/fs/sqlite` with the root `createLibsqlDb` handle. `FilesTable<D, TOwner>` now names the dialect; plain `FilesTable` means either. SQLite limits:

  - Cleanup workers in different processes take turns instead of running in parallel: SQLite has one writer and no `SKIP LOCKED`, so the sweep claims rows with one `UPDATE … RETURNING` inside a write transaction.
  - Timestamps keep milliseconds (Postgres keeps them too: `timestamptz(3)`).
  - The `char(64)` limit on `sha256` is enforced by the kit's `length()` CHECK; the hex check uses `regexp`.

- d733e1d: The files lifecycle returns its expected outcomes as `@arki/failure` values instead of throwing a `FileStorageError`. `createUpload`, `confirmUpload`, `get`, `url` and `remove` now return the value or `FileUnavailable` (`fs.file_unavailable`, 404: missing, not yours, other bucket, or the policy refused; one failure so nobody can probe which files exist), `UploadPending` (`fs.upload_pending`, 409: the PUT has not landed), `FileWrongState` (`fs.file_wrong_state`, 409) or `UploadMismatch` (`fs.upload_mismatch`, 422). They are exported from `@arki/fs/files`. `filesContract` lists them per procedure with `errorMap`, so clients get typed errors and can `reviveRpcError` them. Codes `ARKI_FS_E002` to `E005` are removed; bad input, the local adapter and store faults (`E001`, `E006`, `E007`) stay thrown. Breaking: check results with `isFailure(result)` instead of catching.
- e02d7ca: Add the files table: a Postgres-backed upload recipe (`createUpload → PUT → confirmUpload → url → remove`).

  - New entries: `@arki/fs/files` (ids, wire schemas, error codes, `uploadFile`), `@arki/fs/pg` (`filesTable`,
    `fileStorage`, the sweep), `@arki/fs/orpc` (`filesContract`, `filesRouter`), `@arki/fs/testing`
    (`memoryUploadAdapter`).
  - `SignedUrlOptions` takes `contentType`, `contentLength` and `ifNoneMatch: '*'` for `put` URLs; all three are
    signed. New `SignedUploadAdapter` type: `createS3StorageAdapter` and `createR2Storage` return it,
    `createLocalStorageAdapter` does not.
  - Fix: presigned PUT URLs no longer carry the CRC32 of an empty body (`requestChecksumCalculation:
'WHEN_REQUIRED'`), which made real uploads fail the checksum.
  - Fix: the key prefix was applied twice on writes through `put`. Objects written with a non-empty `prefix`
    before this change sit at `prefix/prefix/key`; move them to `prefix/key` (signed URLs, `getMetadata` and
    this release's `put` all use `prefix/key`).
  - Fix: S3 `getMetadata` throws `ARKI_FS_E007` when the store returns no `Content-Length` or `Content-Type`,
    instead of inventing `0` and `application/octet-stream`.

- bcdf53a: Return canonical storage, SQL, cancellation and write-uncertainty outcomes through adapters, file lifecycle,
  RPC and browser upload workflows. Confine local object keys, settle every readFirstLine terminal path,
  prevent replay after lost S3 acknowledgements, and emit safe default OTel spans and metrics.

  Docs and examples describe the new failure checks, native RPC client bridge, cleanup duty and local
  filesystem limits. No demo impact: this package has no standalone demo.

- ebc681b: Local `put` into a base path that is a regular file now returns `StorageRejected` (was `UnexpectedDefect`). Local `put` writes to a temporary file beside the target and renames it, so a failed or cancelled overwrite keeps the old bytes. `initializeStorage` from `@arki/fs/s3` builds its S3 client when called, not when the module loads, and its header says it returns the raw Flystorage object. `readFile` logs through `@arki/log` (no `console.debug`) and documents its throws. The `local/write`, `local/delete` and `local/glob` pass-throughs document that their errors are raw. Removed the dead `ARKI_FS_E007` code, `FileStorageError.retryable` and the `isFileStorageError` guard; use the new `fileStorageError` schema with `is(error, fileStorageError)` from `@arki/schema`. The oRPC `data` of a thrown `FileStorageError` is now `{ code }` only.
- e132ad3: Return exact ID generation failures from `defineId` and Auth generators, preserving
  successful prefixes and schema types. Validate and bound the entropy provider
  protocol; retain private causes and observe malformed asynchronous output.

  Propagate failures through modern consumers. Drizzle scalar defaults bridge at
  the foreign callback, while owned transactions restore canonical identity and
  roll back without replaying a returned refusal. FS upload creation returns before
  I/O and declares the same failure tuple in its native RPC contract.

  Handle `isFailure(id)` before using a generated ID. Derive stored ID types from
  the declaration or schema, not the generator's `ReturnType`. See Contracts'
  `docs/upgrades/typed-ids.md`. Legacy DB generators remain unchanged pending their
  separate consumer migration.

### Patch Changes

- e132ad3: Document actionable fixes and verification commands for canonical error definitions.

  Journal command/workflow failures and Embeddings failures also expose the missing runtime remediation guidance. Existing failure codes, data and inferred unions are unchanged.

- e132ad3: Object checks on unknown values now use `is(value, recordSchema)` from `@arki/schema` instead of hand-written `typeof value === 'object'` guards. Behaviour is unchanged.
- 5d55e12: Remove Zod types from more public declarations, with no API change. `@arki/db`: `TransactionSettings` and `ResolvedTransactionSettings` are plain types, locked to their schema by an exact type test. `@arki/fs`: the `./pg` and `./sqlite` declarations no longer reach the wire schemas, and `UploadRequest` is a plain type with the same lock. `@arki/lock`: the table name schema is private to `pg/lease.sql`.

  No docs impact: no public name or behaviour changed. No demo impact: same reason.

## 0.1.3

### Patch Changes

- Updated dependencies
  - @arki/contracts@0.0.2
  - @arki/env@0.0.3

## 0.1.2

### Patch Changes

- Updated dependencies
  - @arki/env@0.0.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @arki/contracts@1.0.0
