# @arki/embeddings

## 0.1.0

### Minor Changes

- 86d6562: Smaller vectors, and the space before the first embed.

  - `truncate(vector, dimensions, model)` keeps the first `dimensions` values of a Matryoshka vector and re-normalises them when the model's vectors are unit length. A size not in `model.matryoshka` is `UnsupportedInput`.
  - `quantize(vector, 'binary')` packs one bit per dimension, set above 0, most significant bit first (byte-identical to sentence-transformers and Transformers.js). `unpackBits` turns bits back into ±1 floats, and `hamming` counts differing bits for a first pass.
  - `calibrateInt8(sample)` returns one per-dimension `[min, max]` range for a corpus, and `quantize(vector, 'int8', calibration)` maps onto -128…127 with it.
  - `createEmbedder` makes binary itself when the provider cannot, and int8 when given a `calibration`. The space then names the calibration (`EmbeddingSpace.calibration`, `…/i8@<16 hex>/…` in `spaceId`), so indexes made with different ranges are different spaces. Breaking: binary is no longer refused for providers without native binary; a size that is not a multiple of 8 is refused with `part: 'dimensions'`.
  - `resolveSpace(embedder)` answers the space with Ollama's digest read up front (no embedding), or `ModelUnavailable` with `unreachable` or `not-pulled`. Use it before comparing with stored space ids. Model records gain an optional `loadRevision`.
  - `Embedder.spaceFor({ dimensions?, quantization? })` answers the space a call with those options produces. `withCache` keys on it, so a per-call dtype on a calibrated embedder hits its own entries. Breaking for hand-written `Embedder` objects: they need `spaceFor` (`withMiddleware` passes it through).
  - `resolveEmbeddingModel(…, { requiredSpace })` now accepts a quantized stored space for the model that made it: the dtype belongs to the embedder, not the model.

  Review fixes: `withCache` no longer rebuilds the per-call space itself (a per-call binary on an int8 embedder, or a per-call int8 on a calibrated one, missed every time); `quantize` and `calibrationId` refuse a calibration whose `min` and `max` differ in length.

- 779194e: `@arki/embeddings`: first API: EmbeddingModel, EmbeddingSpace, createEmbedder, embed, embedMany, ./ollama, ./openai, ./openai-compatible, ./env, ./testing. Every result carries a space id; output is validated (count, dimensions, finite, non-zero norm) and failures are values.

  `@arki/ai`: vector stores take vectors and `{ space }`; text-in methods removed; `scroll` added.

- 9b65562: `@arki/embeddings`: instructions, long inputs, retries and middleware.

  - `EMBEDDINGGEMMA_INSTRUCTION`, `NOMIC_INSTRUCTION` and `E5_INSTRUCTION`. Ollama's `embeddinggemma` and `nomic-embed-text` records now apply their prefixes, so their space id moves from `i0` to `i1`: re-embed an index built with them, or pass `instruction: NO_INSTRUCTION` to keep querying it.
  - `onTooLong: 'fail' | 'truncate'`. `'fail'` (default) returns `InputTooLong { index, tokens, max }` before any request, and from a provider's context-length 400 (naming the longest input). `'truncate'` sends Ollama `truncate: true` and cuts OpenAI and OpenAI-compatible inputs at `maxInputTokens * 4` characters. `UnsupportedInput` no longer has the `'truncate'` part. `InputTooLong.index` from `embedMany` now counts within all inputs, not within a chunk.
  - `countTokens` is `counted` when a model record carries a tokenizer (the new optional `EmbeddingModel.countTokens`), `estimated` otherwise.
  - `normalizeText(text, { romanianDiacritics? })`: NFC, collapsed whitespace, optional ş/ţ → ș/ț. The embedder never calls it.
  - `withMiddleware(embedder, ...middleware)` (first outermost) and `withResilience(embedder, policy?)` on `@arki/resilience`: retries only `RateLimited` (at least `retryAfterMs` apart) and `ModelUnavailable { reason: 'unreachable' }`; `usage.requests` counts every attempt.
  - Review fixes: `embedMany` with `onTooLong: 'fail'` now refuses an over-long input before any chunk is sent, so no earlier chunk is billed. `'truncate'` on OpenAI and OpenAI-compatible never cuts a character in half (an emoji at the cut is dropped whole). A provider's context-length 400 names the input with the most tokens by `countTokens`, using the record's tokenizer when it has one. The default `withResilience` policy waits out a `retryAfterMs` of up to 5 s; a longer one is not retried and the `RateLimited` comes back at once. A policy you pass gets no `retryAfterMs` minimum.

- f8a0e13: Voyage, Cohere, Google and Mistral, and recorded fixtures.

  - `@arki/embeddings/voyage`: `createVoyageModel({ id?, apiKey, baseURL?, fetch? })` over plain `fetch`. `voyage-3.5` (default), `voyage-3.5-lite`, `voyage-3-large`, `voyage-code-3`; `input_type` from the purpose; Matryoshka sizes 2048/1024/512/256; native int8 and binary (`ubinary`, MSB first); `truncation` is off unless `onTooLong: 'truncate'`; rows are matched by `index`.
  - `@arki/embeddings/cohere`: `createCohereModel(…)` over plain `fetch`. `embed-v4.0` (default), `embed-english-v3.0`, `embed-multilingual-v3.0`; `input_type` is always sent (`search_document` for documents, similarity and no purpose); native int8 and binary; `truncate: 'NONE'` unless asked.
  - `@arki/embeddings/google`: `createGoogleModel(…)` through `@ai-sdk/google` (optional peer). `gemini-embedding-001` (default) maps the purpose to `taskType` and re-normalises sizes below 3072; `gemini-embedding-2` uses its documented prefixes (`GEMINI_EMBEDDING_2_INSTRUCTION`, its own version). Google reports no usage, so tokens are `unknown`.
  - `@arki/embeddings/mistral`: `createMistralModel(…)` through `@ai-sdk/mistral` (optional peer), `mistral-embed`.
  - `resolveEmbeddingModel` builds Voyage and Google in the provider order, and Cohere, Mistral and OpenAI-compatible servers when named (`COHERE_API_KEY`, `MISTRAL_API_KEY`, `OPENAI_COMPATIBLE_{BASE_URL,DIMENSIONS,API_KEY}`). `./env` validates the new variables.
  - `@arki/embeddings/testing`: `recordEmbedder(embedder, path)` writes every text call to a JSON file; `fixtureEmbedder(recordings)` replays exactly those calls offline and answers `InvalidOutput` for anything else.
  - Model records receive the call's `purpose` in `NativeRequest`, for providers that take it as a field.

  Review fixes: replay's `space` is the recording embedder's own space, not the first call's; a recording path that cannot be written is `ConfigurationFailure`, not a throw; replay honours an aborted `signal`; the recorded request schema is locked to `EmbedOptions`; one shared `vectorsByIndex` and one looser "input too long" match serve every fetch adapter; live tests check that Voyage and Cohere binary use our bit order.

- 36e475d: One dedicated integration per provider (A-42). The package no longer reads environment variables.

  - Removed `resolveEmbeddingModel`, the `EmbeddingModelRef` (`provider:model`) type, `EnvSource`, the `EMBEDDING_MODEL` variable and the automatic provider order (`ollama → openai → voyage → google`), and the `./env` entry (`resolveEmbeddingConfig`). Build the model with the provider's own factory from your app's settings: `createOllamaModel({ id, baseURL })`, `createOpenAIModel({ apiKey })`, and so on. No app in the monorepo used the resolver.
  - `resolveSpace` stays and moves next to `spaceId`; `isSameSpace(stored, await resolveSpace(embedder))` replaces `resolveEmbeddingModel(…, { requiredSpace })`.
  - `embeddings()` from `./dot` now requires `model`: a model record, an `Embedder`, or a function returning one or a failure. The `env` option is gone; read your env inside the function, which runs at boot.
  - Each provider adapter parses its own response and recognises its own "input too long" wording. The shared `vectorsByIndex`, `mentionsContextLength` and `providerInputTooLong` helpers are gone; `retryAfterMs` (the standard HTTP header) stays shared.
  - `@arki/env` is no longer a dependency.

  Upgrade: replace `resolveEmbeddingModel(ref, process.env)` with the provider's `createXModel` call; replace `embeddings({ model: 'ollama:…' })` with `embeddings({ model: () => createOllamaModel({ … }) })`.

  no demo impact: no demo builds an embedding model.

- b10825c: Reranking. `@arki/ai`'s rerankers are removed; use `@arki/embeddings`.

  - `@arki/embeddings/rerank`: `rerank(reranker, query, items, { text, topK?, onTooLong?, signal? })` splits the items over the reranker's `maxDocuments`, merges the scores and keeps `topK` after the merge, so a per-request cut never drops a global winner. Each hit carries the caller's item, its index and its score. `withRerankCache(reranker, store)` keeps one score per provider, model, revision, truncation, query and document. The `Reranker` type, `RERANK_PROVIDERS`.
  - Long documents: `onTooLong: 'fail'` (default) returns `InputTooLong` naming the item before any request; `'truncate'` lets the provider cut; `'split'` scores overlapping windows and keeps the best window's score.
  - Each reranker lives in its provider's entry: `createCohereReranker` and `createCohereCompatibleReranker` (Infinity, vLLM, llama.cpp) in `./cohere`, `createVoyageReranker` in `./voyage`, `createJinaReranker` in `./jina`, `createTransformersReranker` (bge-reranker-v2-m3 or Qwen3-Reranker-0.6B, in process) in `./transformers`, and `createTeiReranker` in the new `./tei` entry. All over plain `fetch` except the in-process one.
  - `@arki/embeddings/testing`: `fakeReranker({ scores?, seed?, maxDocuments?, maxInputTokens? })`.
  - `bench/quality/rerank.eval.ts` (`bun run eval:rerank`): nDCG@10 and MRR@10 uplift over the same dense top 50 on SciFact, NFCorpus and FiQA slices. `bench/rerank.bench.ts`: `rerank()` against raw Transformers.js on the same weights.
  - The package now lints with the `@arki/eslint-config/library` preset; `vectorsByIndex` and the sparse row sort no longer use `Array#toSorted`, which Hermes lacks.
  - `@arki/ai`: `embeddings.rerankers` (`CohereReranker`, `VoyageReranker`, `JinaReranker`, `TeiReranker`, `MixedbreadReranker`, `BedrockReranker`, `createReranker`) is removed. The Mixedbread and Bedrock rerankers are not ported: nothing used them. Move a TEI reranker to `createTeiReranker`, the others to the matching `@arki/embeddings` entry, and call them through `rerank()`.

  no demo impact: no demo uses reranking.

- 115edae: Every public options object has a Standard Schema, exported next to its type (for example `cohereRerankerOptionsSchema`, `embedOptionsSchema`, `embeddingsPluginOptionsSchema`). Each one answers a JSON Schema; a function field shows as any value. An exact two-way type test locks each schema to its type.

  - Factories check their options with the schema. A bad option returns a `ConfigurationFailure` naming the field. `createEmbedder` can now return one too.
  - Per-call options (`embed`, `embedMany`, `embedStream`, `rerank`, `normalizeText`, sparse) are checked with `assert`: a bad value is a caller bug and throws.
  - `concurrency` or `maxPending` of `0`, `NaN` or a negative number now throws. It used to fall back to 1.
  - `withRerankCache` and `createTransformersReranker` throw on bad options, because they cannot return a failure.

- 7c8ab60: `@arki/kv` data methods return typed failures instead of rejecting with the raw Redis error. `get` and `mget` take a schema (any Standard Schema) and return the checked value, `undefined` for a missing key, or `KvValueInvalid`. Every method returns `KvUnavailable` when Redis is down, slow (`commandTimeoutMs`, default 5000) or drops the reply, and `KvCancelled` when the `signal` option aborts; after a failed write the effect is unknown. `mset` now applies its TTL, and `setIfNotExists` writes the same stored format as `set`, so `get` reads it back. `close()` returns `KvCloseFailed` instead of logging to the console. TLS certificates for a `rediss://` URL are now verified; skipping the check needs `allowUnverifiedTls: true` (or `KV_ALLOW_UNVERIFIED_TLS`). A rate limiter made while Redis is not ready is listed in `degradedRateLimiters` and is rebuilt on Redis once the connection is ready. Every command runs under a `kv.<command>` span. The consumers follow: `@arki/admin` `ReceiptKV`, `@arki/embeddings` `kvCacheStore`, `@arki/geo` `GeocodingCache` and `@arki/mail` `QuotaStore`/`kvQuotaStore` take the new `get(key, schema)` and failure-returning methods; a cache or quota failure is logged and read as a miss.

  `@arki/kv` no longer exports `RateLimitExceededError`: nothing in kv threw it. `getRateLimiter(...).consume()` rejects with the limiter's own `RateLimiterRes`, which `@arki/kv` now re-exports; check it with `instanceof` and read `msBeforeNext`. `get` and `mget` now return a schema failure that is not a wrong shape (an async schema, a validator defect) as the failure itself; before, it was returned as if it were the stored value.

- e80211d: Return exact canonical engine refusals and final defects while preserving raw throw retry/fallback provenance. Remove obsolete operational error classes and guards; preserve static backoff diagnostics. Capture timeout/caller cancellation before observation. Infer heterogeneous policy unions.

  Migrate HTTP response/network mapping, DB exhausted SQLSTATE conflicts, Embeddings defect admission and RPC consumers together. See the Resilience 0.2.0-to-0.3.0 upgrade guide. No demo impact: the affected app callers and generator admission guidance are migrated in place.

- aa101f2: First public release of `@arki/embeddings`: one `Embedder` shape over Ollama, OpenAI and OpenAI-compatible servers, with checked output, failures as values and spaces that stop mixed vectors.

  no demo impact: drop-studio, the only registered demo, does not import `@arki/embeddings`; it reaches it only through `@arki/ai`, which the `@arki/ai` admission changeset covers and whose public API this release does not change.

- 0faf836: `@arki/embeddings`: a vector cache, telemetry events, a KV store and a Dot plugin. `@arki/ai`: `vectorIndex()` no longer provides `embedder`.

  - `withCache(embedder, store?, { strict?, namespace?, ttlMs? })`: answers repeated texts from a byte store. The key is a SHA-256 of the space id, purpose, size, dtype, truncation choice, namespace and exact text, so a model, size or prompt change misses. Cached inputs are filled and the rest go to the provider as one call, in order; `usage.cacheHits` counts the hits. `strict: true` (default) returns `InvalidOutput` for a cached value that does not fit the space; `strict: false` re-embeds it. A store that throws is a miss.
  - `memoryCacheStore({ maxEntries? })`: an in-process LRU that copies on set and on get.
  - `withTelemetry(embedder, { log?, recordInputs? })`: one `arki.embed` event per call with provider, model, dimensions, input count, tokens, requests, cache hits, duration and outcome. Input texts stay out unless `recordInputs: true`.
  - `@arki/embeddings/kv`: `kvCacheStore(kv, { prefix? })` stores cached vectors as base64 through an `@arki/kv` client.
  - `@arki/embeddings/dot`: `embeddings({ model?, cache?, resilience?, env? })` publishes `embedder: Embedder | null`, built once at boot. `model` takes a ref, a model record, an `Embedder` or a factory. A configuration that does not resolve logs once at `warn` and publishes `null`. `@arki/dot` is an optional peer.
  - `@arki/ai`: `vectorIndex()` no longer provides `embedder` and no longer reads the old embedding runtime. It takes `space` (an `EmbeddingSpace`, an `Embedder`, `null`, or a function returning one) and sizes the index from it; mount `embeddings()` from `@arki/embeddings/dot` for the embedder. The `runtime` option is gone.
  - `@arki/ai`: `ReconcileDeps` takes `space: EmbeddingSpace` in place of `targetDimensions` and `model`. `embedText` may return an `EmbedFailure`, which counts the row as failed. Re-embedded points record `model: space.model` and `space: spaceId(space)` (`VectorPointPayload.space` is new and optional).
  - Review fixes: the cache key hashes its fields as a JSON array led by a value-format version (`v1`), so a `|` in `namespace` can no longer collide with the text and a future value format misses instead of failing strict mode; the docs say a strict failure on a foreign value lasts until its TTL. `ReconcileDeps.embedText` returns `{ vector, space }`, and re-embedded points record that space, so a revision Ollama learns on the first call is recorded from the first run.

- 71de1af: EmbeddingGemma 2 in `./transformers`, and the quality eval.

  - `createTransformersModel({ id: 'onnx-community/embeddinggemma-2-ONNX' })` knows EmbeddingGemma 2 (Apache-2.0): pinned to one commit, 768 dims with Matryoshka sizes 512/256/128, 8,192 input tokens, and its own `EMBEDDINGGEMMA_2_INSTRUCTION` (the same prefixes as EmbeddingGemma today, versioned apart). The in-process default stays EmbeddingGemma 300M until the Romanian gate can run.
  - `bench/quality.eval.ts` (`bun run eval`): nDCG@10, recall@10/50 and MRR@10 on SciFact and NFCorpus, Spearman on RO-STS, a BM25 floor, gate D1, and a wrapper-vs-raw self-check. It reads any folder in the BEIR shape with `--dataset`.

- cac4bc6: Jina, Bedrock, image inputs and sparse vectors.

  - `@arki/embeddings/jina`: `createJinaModel({ id?, apiKey, baseURL?, fetch? })` over plain `fetch`, `jina-embeddings-v3` (1024 dims, sizes 1–1024, `task` from the purpose, truncation off unless asked).
  - `@arki/embeddings/bedrock`: `createBedrockModel(…)` through `@ai-sdk/amazon-bedrock` (optional peer, Node and Bun), Amazon Titan Text Embeddings V2 (1024/512/256).
  - Image inputs: `{ image, mimeType?, text? }` reaches a provider through the new optional `EmbeddingModel.embedInputs` (`NativeInput`, `NativeInputsRequest`); the media type is read from the bytes when left out; a model that cannot take images refuses before any request. `gemini-embedding-2`, Cohere `embed-v4.0` and Voyage `voyage-multimodal-3.5`/`voyage-multimodal-3` take images.
  - `@arki/embeddings/sparse`: `createSparseModel` over TEI `/embed_sparse` (SPLADE). `SparseSpace` carries the tokenizer `vocabulary`; a vocabulary mismatch is `SpaceMismatch`. New provider name `tei`.
  - `resolveEmbeddingModel` builds Jina (`JINA_API_KEY`) and Bedrock (`AWS_REGION` and AWS credentials from the env passed in) when named.
  - `@arki/ai`: `QdrantVectorProvider` takes `sparseSpace`, stores a named sparse vector next to the dense one (`upsertVector(id, vector, metadata, sparse)`) and adds `searchBySparseVector`. Dense-only collections are unchanged.

- 46129c8: Add `@arki/embeddings/transformers` and `embedStream`.

  - `createTransformersModel()` runs a model in process with Transformers.js (optional peer `@huggingface/transformers`). The default is EmbeddingGemma 300M `q8`, pinned to one Hugging Face commit. The factory is async: it loads the model and embeds one probe text, so `dimensions` is what the weights produce. Concurrent creates share one load, `dispose()` frees the session after the last record lets go, and `countTokens` counts with the loaded tokenizer. Node, Bun and the browser; not Hermes.
  - `embedStream(embedder, source, { text, concurrency?, maxPending? })` embeds an iterable or async iterable as a pull-based `ReadableStream` of `{ item, result }` in source order. Memory stays flat, a failed request gives each of its items the failure and the stream goes on, and cancelling aborts the requests in flight.

  Review fixes: a throw from the source, `text` or the model inside `embedStream` now aborts in-flight requests, closes the source and drops the `signal` listener; a shared Transformers.js load reports `loadMs` once across records; benches parse JSON and model output with zod; the EmbeddingGemma `q8` size reads "about 316 MB" everywhere.

- cac4bc6: `./ollama` knows `qwen3-embedding:4b`, the fleet's GPU tier: 2,560 dims with Matryoshka sizes down to 256, 32,768 input tokens and the Qwen3 prefixes, so it no longer needs `dimensions` and `instruction` passed by hand.
- ba05496: Server faults and bad configuration are told apart from bad answers. Breaking in 0.x.

  - A provider answer with status 500 or above is now `ModelUnavailable { reason: 'unreachable' }` in every HTTP and SDK model and reranker (`openai`, `openai-compatible`, `cohere`, `google`, `jina`, `voyage`, `mistral`, `bedrock`, `ollama`, `tei`, `sparse`), not `InvalidOutput`, so `withResilience` retries an outage. Ollama answering 401 or 403 (a proxy in front of it) is `ConfigurationFailure`.
  - Every provider request runs under a 60 s timeout joined with the caller's signal (`requestSignal`). A timeout is `ModelUnavailable { reason: 'unreachable' }`; a caller abort stays `Cancelled`.
  - The Transformers model and reranker honour the abort signal before and after a batch. A runtime fault (out of memory, a failed session) is `UnexpectedDefect`, not `InvalidOutput`.
  - The Dot `embeddings()` plugin no longer publishes `null` for a configuration that does not build. `boot()` returns the `ConfigurationFailure` (a bad option, a missing key, a refused size) and the plugin logs it at `error`. The published `embedder` is `Embedder`, not `Embedder | null`. An app that can run without embeddings must not mount the plugin.
  - `cosine` throws for vectors of different lengths instead of scoring the shorter prefix.

### Patch Changes

- a6cae86: Infer `EmbedFailure` from the same canonical definition tuple used by
  `isEmbedFailure`. Existing failure codes, payloads and public types are unchanged.
- 440c75f: Dot's kernel atom is now a **unit**, and its constructor says its role. Breaking (0.x, so a minor):

  - The builder has three steps, always in this order: `defineApp(name).infra(...).features([...]).entrypoints(...)`. `.use()`, `.useAll()` and `.serve()` are removed: write `.use(x)` as `.infra(x)`, `.useAll(list)` as `.infra(...list)`, and `.serve(x)` as `.entrypoints(x)`. `.infra(a, b)` checks the list in order, like separate calls.
  - `plugin({...})` → `infra({...})` for infrastructure (a database, a cache, a mailer, an outside client). `.infra(...)` mounts it.
  - A unit served from `.entrypoints(...)` is now `entrypoint({...})`.
  - `driven(features => plugin({...}))` → `infra.fromFeatures(features => unit({...}))`; `driver(features => plugin({...}))` → `entrypoint.fromFeatures(features => unit({...}))`. `unit({...})` is the role-less atom and belongs only inside `fromFeatures`.
  - `@arki/dot/plugin` → `@arki/dot/unit`. Every `Plugin*` type is now `Unit*` (`Unit`, `AnyUnit`, `UnitNeeds`, `UnitPhases`, ...); `Driver` / `Driven` → `EntrypointBinder` / `InfraBinder`; `DotPluginError` → `DotUnitError`; `testPlugin` → `testUnit`; `initPlugins` → `initUnits` (its factory method `.plugin` → `.infra`); a feature's `.plugins()` → `.units()`; the context key `$plugin` → `$unit`.
  - `UnitRole` is `'infra' | 'feature' | 'entrypoint'` (was `'feature' | 'driving'`, with infra unlabelled). Every mounted unit has a role, and the manifest shows it.
  - The builder checks the side: `.infra()` refuses an entrypoint, and `.entrypoints()` refuses an infra or feature unit, at compile time. An erased graph fails `configure()` with the new `ARKI_DOT_E033` (`DotLifecycleErrorCode.UnitOnWrongSide`).
  - OpenTelemetry attributes: `dot.plugin.*` → `dot.unit.*` and `dot.app.plugin.count` → `dot.app.unit.count`. Update dashboards and alerts that query them.
  - `dot explain --graph` groups the hexagon as `infra` / `features` / `entrypoints`.
  - Domain logic with no usecases is still a feature: `defineFeature('orders').needs({...}).provides({...}).entrypoints()`. The quickstart now teaches this shape.

  Not yet renamed: the manifest and diagnostics JSON keys (`plugins`, `plugin`, `registeringPlugin`). A follow-up renames them. `@arki/dot/plugin` and `plugin` stay as aliases of `@arki/dot/unit` and `infra` inside the monorepo until then, and will be removed before this ships.

  The adapters move to the new names and the new steps (`@arki/tanstack-start`'s `tanstackStart(...)` is now built with `entrypoint`, so it mounts only with `.entrypoints(...)`, as before).

  demo impact: drop-studio's and faultline's Dot code uses `plugin(...)` and `@arki/dot/plugin`; rename on their next upgrade.

- e132ad3: Hand-written object guards now come from `@arki/schema` (`is(value, recordSchema)` or `plainObjectSchema`), per A-39. Replaced: the `isRecord`/`isPlainObject`/`isObject` helpers in `dot`, `cli`, `http`, `expr`, `lock`, `mail`, `embeddings` (its internal `isRecord`, not a public export), `testing` and `payments`, plus inline `typeof x === 'object' && x !== null` checks on unknown values. Behaviour is the same, except that the inline checks and `lock`'s guard no longer let arrays through. `@arki/expr` and `@arki/lock` now depend on `@arki/schema`.
- 087023b: Add `fromArkiEmbedder(embedder)` to `@arki/embeddings/testing`, moved from `@arki/testing/ai`. It turns any embedder into the embedder that `similarTo` and the judge of `@arki/testing/ai` take. Texts go in as `purpose: 'document'`; a failure becomes a thrown `Error` with the failure's message. `@arki/testing` is a new optional peer, used for types only.

  no demo impact: no demo uses `fromArkiEmbedder`.

- b992897: Return canonical retry cancellation before dispatch and after cancelled rejected work, preserving completed outcomes and actual clock failure identity. Propagate the exact inferred RetryFailure union through helpers, composition and Dot; update Embeddings and HTTP policy types, RPC failure declarations and application template guidance. DB maps retry cancellation to its existing TransactionCancelled; Games Platform persists it as cancellation.

  no demo impact: no demo declares the narrower retry-wait outcome type; application failure admission is migrated. Embeddings changes only its existing optional policy type/schema binding.

- e132ad3: Document actionable fixes and verification commands for canonical error definitions.

  Journal command/workflow failures and Embeddings failures also expose the missing runtime remediation guidance. Existing failure codes, data and inferred unions are unchanged.

- 11c5bc2: Complete public error summaries and remediation metadata. The source error index now follows canonical factory aliases, checks duplicate original codes across packages, and enforces documentation for private libraries too. Runtime behavior and failure data are unchanged.

  No demo impact: this changes error documentation and repository checks only.
