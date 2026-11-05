---
"@arki/fs": patch
---

Building the legacy `initializeStorage` Flystorage handle now runs in an `fs.s3.initialize_storage` span and counts in `fs.operations` and `fs.operation.duration`, under the caller's active span. No bucket, prefix, region or credential is recorded. The handle's own Flystorage calls still carry no span; `createS3StorageAdapter` remains the instrumented S3 path.
