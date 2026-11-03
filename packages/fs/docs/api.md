# @arki/fs API reference

Every exported value, grouped by import path. Types are not listed. For how the pieces fit together, read `agent-guide.md` and the README.

## @arki/fs/env

- `env`: the validated environment values the file helpers read (storage provider and bucket settings).

## @arki/fs/local/delete

- Re-exports everything from the `del` package (`deleteAsync`, `deleteSync`). They remove files and folders by glob.

## @arki/fs/local/dir

- `getParentDirName`: the name of the folder that holds a given path.

## @arki/fs/local/glob

- `glob`: finds files that match a pattern and returns them in one list.
- `globIterate`: finds matching files and yields them one at a time.
- `globStream`: finds matching files and returns them as a stream.

## @arki/fs/local/read-file

- `readFile`: reads a whole file synchronously and decodes it. It is a load-time reader for bundled data files, so it keeps a documented throw instead of returning a failure.

## @arki/fs/local/read-first-line

- `readFirstLine`: the first line of a file, or undefined for an empty file. Every path closes the stream.

## @arki/fs/local/write

- `writeToTheFileEnd`: appends data to the end of a file (Node `appendFile`).

## @arki/fs/s3

- `initializeStorage`: builds a file storage client for an S3 bucket from an optional bucket name, path prefix and region.

## @arki/fs/storage (also @arki/fs/storage/index)

- `createStorage`: creates a storage instance from a config. It picks the local or the S3 adapter from the provider named in the config.
- `createLocalStorageAdapter`: creates the adapter that keeps files on local disk.
- `createS3StorageAdapter`: creates the adapter that keeps files in an S3 compatible bucket and signs uploads.
- `createR2Storage`: creates a signed-upload adapter backed by Cloudflare R2.
- `FILE_READ_FAILURES`: the failures a file read can return.
- `STORAGE_READ_FAILURES`: the failures a read or signing call can return. These calls do no external write.
- `STORAGE_WRITE_FAILURES`: the failures a write can return. A dispatched write keeps its uncertainty instead of claiming nothing happened.
- `StorageCancelled`: cancellation stopped the next phase or a read. Writes already acknowledged remain.
- `StorageNotFound`: the requested local file does not exist.
- `StorageRejected`: storage refused an operation and did not confirm a write.
- `StorageUnavailable`: a read could not reach its storage backend.
- `StorageWriteUncertain`: an external write may have happened, but its final state was not confirmed.

## @arki/fs/storage/local-adapter

- `LocalStorageAdapter`: the storage adapter class for local disk.
- `createLocalStorageAdapter`: creates a `LocalStorageAdapter` from its config.

## @arki/fs/storage/r2

- `createR2Storage`: creates a signed-upload adapter backed by Cloudflare R2.

## @arki/fs/storage/s3-adapter

- `S3StorageAdapter`: the signed-upload adapter class for S3 compatible buckets.
- `createS3StorageAdapter`: creates an `S3StorageAdapter` from its config.

## @arki/fs/storage/types

- Types only. It has no exported values.

## @arki/fs/files

The client and shared side of the files lifecycle.

- `uploadFile`: uploads a blob through an upload client: asks for a ticket, sends the bytes, then confirms.
- `fileId`: schema for the id of a stored file: `fil_` plus 24 random characters.
- `fileRecord`: schema for what clients see of a file. It has no bucket, key, owner or etag.
- `fileStatus`: schema for the file state: `pending` until the server saw the object, `ready` after, `deleting` until the sweep removes row and object.
- `mimeSchema`: schema for a plain `type/subtype` media type. No parameters, no control characters.
- `uploadRequest`: schema for what a client asks for before it uploads.
- `uploadTicket`: schema for a signed, create-only PUT grant. Send its `headers` unchanged.
- `signedFileUrl`: schema for a GET URL and the moment it stops working, so screens can refresh before then.
- `fileStorageError`: schema that recognises a `FileStorageError` on unknown values.
- `FileStorageError`: a coded failure of the files table or one of its adapters.
- `FILE_ERROR_CODES`: the stable error codes of `@arki/fs/files` and `@arki/fs/pg`.
- `FileUnavailable`: the file is missing, belongs to another bucket binding, or the policy denied the call. One failure for all three, so a caller cannot probe which.
- `FileWrongState`: the file is not in the state the call needs, for example a URL for a file that is not ready.
- `UploadMismatch`: the stored size, type or hash differs from the upload request. The row is now deleting.
- `UploadPending`: confirm came before the PUT finished. The row stays pending, so confirming again later is fine.
- `CREATE_UPLOAD_FAILURES`: the declared refusals of upload creation.
- `CONFIRM_UPLOAD_FAILURES`: the failures confirming an upload can return.
- `FILE_READ_FAILURES`: the failures a file read can return.
- `FILE_URL_FAILURES`: the failures asking for a signed file URL can return.
- `REMOVE_FILE_FAILURES`: the failures removing a file can return.
- `UPLOAD_FILE_FAILURES`: the failures `uploadFile` can return across all its steps.
- `STORAGE_READ_FAILURES`, `STORAGE_WRITE_FAILURES`, `StorageCancelled`, `StorageNotFound`, `StorageRejected`, `StorageUnavailable`, `StorageWriteUncertain`: the storage failures, same as in `@arki/fs/storage`.

## @arki/fs/orpc

- `filesContract`: the oRPC contract for the files lifecycle (create upload, confirm, signed URL, remove).
- `filesRouter`: the handlers of `filesContract`. `storage` returns the service built at boot. `actor` returns the acting owner id.
- `filesUploadClient`: restores native oRPC rejection at the client bridge before `uploadFile` runs.

## @arki/fs/pg

- `fileStorage`: builds the files lifecycle once, at boot, on Postgres. It only validates its options and adapter.
- `filesTable`: the Postgres files table, one row per stored object, written before any byte is.
- `toFileRecord`: turns a table row into the record clients see.

## @arki/fs/sqlite

- `fileStorage`: the same files lifecycle on SQLite.
- `filesTable`: the SQLite files table.
- `toFileRecord`: turns a table row into the record clients see.

## @arki/fs/testing

- `memoryUploadAdapter`: an in-memory store with signed uploads. Use one instance per test.
