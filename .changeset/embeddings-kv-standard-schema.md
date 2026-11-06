---
"@arki/embeddings": minor
---

`kvCacheStore` now types `kv.get`'s schema as a Standard Schema of string (`StandardSchemaV1<unknown, string>`) instead of a Zod type, so `@arki/embeddings/kv` names no Zod type. An `@arki/kv` client still fits as it is.
