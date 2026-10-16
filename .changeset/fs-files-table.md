---
'@arki/fs': minor
---

Add the files table: a Postgres-backed upload recipe (`createUpload → PUT → confirmUpload → url → remove`).

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
