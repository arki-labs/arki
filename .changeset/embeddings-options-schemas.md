---
'@arki/embeddings': minor
---

Every public options object has a Standard Schema, exported next to its type (for example `cohereRerankerOptionsSchema`, `embedOptionsSchema`, `embeddingsPluginOptionsSchema`). Each one answers a JSON Schema; a function field shows as any value. An exact two-way type test locks each schema to its type.

- Factories check their options with the schema. A bad option returns a `ConfigurationFailure` naming the field. `createEmbedder` can now return one too.
- Per-call options (`embed`, `embedMany`, `embedStream`, `rerank`, `normalizeText`, sparse) are checked with `assert`: a bad value is a caller bug and throws.
- `concurrency` or `maxPending` of `0`, `NaN` or a negative number now throws. It used to fall back to 1.
- `withRerankCache` and `createTransformersReranker` throw on bad options, because they cannot return a failure.
