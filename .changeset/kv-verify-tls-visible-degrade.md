---
'@arki/kv': minor
---

Breaking changes, found by the T08 review.

- TLS certificates are now verified for `rediss://` URLs. Before, every `rediss://` URL skipped the check. For a self-signed server you trust, pass `{ allowUnverifiedTls: true }` as the fourth argument of `new KV`, set `KV_ALLOW_UNVERIFIED_TLS=true`, or use the `allowUnverifiedTls` Dot option.
- `KV.close()` now returns a `kv.close_failed` failure (`KvCloseFailed`) when a disconnect fails, instead of printing to the console and resolving. The Dot plugin throws it on dispose.
- `@arki/kv/instance` no longer exports `kv`, which built a client when the module loaded. Call `createKVInstance()` once in your app.
- `createKV` and `createRateLimitKV` throw `KVInitializationError` (`KV_INIT_E004`) when no URL is set, instead of a plain `Error`.
- `setIfNotExists` now writes the same key and format as `set`, so `get` reads its value back. `mset` now applies its expiry to every pair.
- The rate limiter fallback to memory is no longer silent: it logs a warning and lists the id in `KV.degradedRateLimiters`. A memory limiter is replaced by a Redis one on the next `getRateLimiter` call after Redis is ready. Before, the memory limiter stayed cached for good.
- `setIfNotExists` and `publish` wait for the Redis connection instead of failing with a raw "Stream isn't writeable" error right after the client is made.
- Every command runs in a `kv.<command>` span and counts in the `kv.commands` metric (new dependency `@opentelemetry/api`). Console output is replaced by `@arki/log`.

No docs impact beyond the README and agent guide, updated here. No demo impact.
