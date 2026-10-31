---
'@arki/kv': minor
'@arki/admin': minor
'@arki/embeddings': minor
'@arki/geo': minor
'@arki/mail': minor
---

`@arki/kv` data methods return typed failures instead of rejecting with the raw Redis error. `get` and `mget` take a schema (any Standard Schema) and return the checked value, `undefined` for a missing key, or `KvValueInvalid`. Every method returns `KvUnavailable` when Redis is down, slow (`commandTimeoutMs`, default 5000) or drops the reply, and `KvCancelled` when the `signal` option aborts; after a failed write the effect is unknown. `mset` now applies its TTL, and `setIfNotExists` writes the same stored format as `set`, so `get` reads it back. `close()` returns `KvCloseFailed` instead of logging to the console. TLS certificates for a `rediss://` URL are now verified; skipping the check needs `allowUnverifiedTls: true` (or `KV_ALLOW_UNVERIFIED_TLS`). A rate limiter made while Redis is not ready is listed in `degradedRateLimiters` and is rebuilt on Redis once the connection is ready. Every command runs under a `kv.<command>` span. The consumers follow: `@arki/admin` `ReceiptKV`, `@arki/embeddings` `kvCacheStore`, `@arki/geo` `GeocodingCache` and `@arki/mail` `QuotaStore`/`kvQuotaStore` take the new `get(key, schema)` and failure-returning methods; a cache or quota failure is logged and read as a miss.
