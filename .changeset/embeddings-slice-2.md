---
'@arki/embeddings': minor
'@arki/ai': minor
---

`@arki/embeddings`: a vector cache, telemetry events, a KV store and a Dot plugin. `@arki/ai`: `vectorIndex()` no longer provides `embedder`.

- `withCache(embedder, store?, { strict?, namespace?, ttlMs? })`: answers repeated texts from a byte store. The key is a SHA-256 of the space id, purpose, size, dtype, truncation choice, namespace and exact text, so a model, size or prompt change misses. Cached inputs are filled and the rest go to the provider as one call, in order; `usage.cacheHits` counts the hits. `strict: true` (default) returns `InvalidOutput` for a cached value that does not fit the space; `strict: false` re-embeds it. A store that throws is a miss.
- `memoryCacheStore({ maxEntries? })`: an in-process LRU that copies on set and on get.
- `withTelemetry(embedder, { log?, recordInputs? })`: one `arki.embed` event per call with provider, model, dimensions, input count, tokens, requests, cache hits, duration and outcome. Input texts stay out unless `recordInputs: true`.
- `@arki/embeddings/kv`: `kvCacheStore(kv, { prefix? })` stores cached vectors as base64 through an `@arki/kv` client.
- `@arki/embeddings/dot`: `embeddings({ model?, cache?, resilience?, env? })` publishes `embedder: Embedder | null`, built once at boot. `model` takes a ref, a model record, an `Embedder` or a factory. A configuration that does not resolve logs once at `warn` and publishes `null`. `@arki/dot` is an optional peer.
- `@arki/ai`: `vectorIndex()` no longer provides `embedder` and no longer reads the old embedding runtime. It takes `space` (an `EmbeddingSpace`, an `Embedder`, `null`, or a function returning one) and sizes the index from it; mount `embeddings()` from `@arki/embeddings/dot` for the embedder. The `runtime` option is gone.
- `@arki/ai`: `ReconcileDeps` takes `space: EmbeddingSpace` in place of `targetDimensions` and `model`. `embedText` may return an `EmbedFailure`, which counts the row as failed. Re-embedded points record `model: space.model` and `space: spaceId(space)` (`VectorPointPayload.space` is new and optional).
- Review fixes: the cache key hashes its fields as a JSON array led by a value-format version (`v1`), so a `|` in `namespace` can no longer collide with the text and a future value format misses instead of failing strict mode; the docs say a strict failure on a foreign value lasts until its TTL. `ReconcileDeps.embedText` returns `{ vector, space }`, and re-embedded points record that space, so a revision Ollama learns on the first call is recorded from the first run.
