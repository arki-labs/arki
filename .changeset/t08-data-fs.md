---
'@arki/fs': minor
---

Local `put` into a base path that is a regular file now returns `StorageRejected` (was `UnexpectedDefect`). Local `put` writes to a temporary file beside the target and renames it, so a failed or cancelled overwrite keeps the old bytes. `initializeStorage` from `@arki/fs/s3` builds its S3 client when called, not when the module loads, and its header says it returns the raw Flystorage object. `readFile` logs through `@arki/log` (no `console.debug`) and documents its throws. The `local/write`, `local/delete` and `local/glob` pass-throughs document that their errors are raw. Removed the dead `ARKI_FS_E007` code, `FileStorageError.retryable` and the `isFileStorageError` guard; use the new `fileStorageError` schema with `is(error, fileStorageError)` from `@arki/schema`. The oRPC `data` of a thrown `FileStorageError` is now `{ code }` only.
