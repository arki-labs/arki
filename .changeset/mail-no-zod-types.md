---
"@arki/mail": minor
---

`KVLike.get` now takes any Standard Schema of number (`StandardSchemaV1<unknown, number>`) instead of a Zod type; an `@arki/kv` client still fits. `QueuedArgs` in `@arki/mail/pg` is a plain TS type and the queue row schemas are internal, so `.`, `./pg` and `./outbox` name no Zod types.
