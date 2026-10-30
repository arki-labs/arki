---
"@arki/db": patch
"@arki/fs": patch
"@arki/lock": patch
---

Remove Zod types from more public declarations, with no API change. `@arki/db`: `TransactionSettings` and `ResolvedTransactionSettings` are plain types, locked to their schema by an exact type test. `@arki/fs`: the `./pg` and `./sqlite` declarations no longer reach the wire schemas, and `UploadRequest` is a plain type with the same lock. `@arki/lock`: the table name schema is private to `pg/lease.sql`.

No docs impact: no public name or behaviour changed. No demo impact: same reason.
