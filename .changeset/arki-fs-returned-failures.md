---
'@arki/fs': minor
---

The files lifecycle returns its expected outcomes as `@arki/failure` values instead of throwing a `FileStorageError`. `createUpload`, `confirmUpload`, `get`, `url` and `remove` now return the value or `FileUnavailable` (`fs.file_unavailable`, 404: missing, not yours, other bucket, or the policy refused; one failure so nobody can probe which files exist), `UploadPending` (`fs.upload_pending`, 409: the PUT has not landed), `FileWrongState` (`fs.file_wrong_state`, 409) or `UploadMismatch` (`fs.upload_mismatch`, 422). They are exported from `@arki/fs/files`. `filesContract` lists them per procedure with `errorMap`, so clients get typed errors and can `reviveRpcError` them. Codes `ARKI_FS_E002` to `E005` are removed; bad input, the local adapter and store faults (`E001`, `E006`, `E007`) stay thrown. Breaking: check results with `isFailure(result)` instead of catching.
