---
'@arki/fs': minor
---

The local file helpers return typed storage failures instead of throwing. `readFile` is now async and resolves to the text, `StorageNotFound` for a missing path, `StorageRejected` for an unknown encoding or a refused read, `StorageUnavailable` or `StorageCancelled` (it takes an optional `signal`). `writeToTheFileEnd` resolves to nothing, `StorageRejected` when nothing was written, or `StorageWriteUncertain`. `deleteAsync` resolves to the deleted paths, `StorageRejected` for a path outside the working directory or a permission error, or `StorageWriteUncertain`. `glob` resolves to the matched paths, `StorageCancelled`, or `UnexpectedDefect` for an invalid option set. Each records an `fs.local.*` span and metric. Removed: `deleteSync`, `globIterate`, `globStream` and the `ProgressData` type. Migration: `await` `readFile` and check the result with `isFailure` before using it; use `deleteAsync` and `glob` in place of the removed sync and stream forms.
