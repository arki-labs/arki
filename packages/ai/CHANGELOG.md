# @arki/ai

## 0.2.0

### Minor Changes

- 779194e: `@arki/embeddings`: first API: EmbeddingModel, EmbeddingSpace, createEmbedder, embed, embedMany, ./ollama, ./openai, ./openai-compatible, ./env, ./testing. Every result carries a space id; output is validated (count, dimensions, finite, non-zero norm) and failures are values.

  `@arki/ai`: vector stores take vectors and `{ space }`; text-in methods removed; `scroll` added.

- a94009e: Embedding providers removed; use `@arki/embeddings`.

  Removed from `@arki/ai`, and what replaces each in `@arki/embeddings`:

  - `createEmbeddingRuntime`, `resolveEmbeddingSelection`, `EmbeddingRuntime`, `EmbeddingSelection`, `EnvSource`: no replacement reads the environment for you. Build the embedder in your app with `createEmbedder(createOllamaModel(...))` (or the OpenAI, OpenAI-compatible, Cohere, Voyage, Google, Mistral, Jina, Bedrock, Transformers model of the same shape). A failure comes back as a value; narrow it with `isEmbedFailure`.
  - `createEmbedder`, `createEmbeddingProvider`, `Embedder` (old shape), `EmbeddingProvider`, `EmbeddingProviderType`, `EmbeddingProviderConfig`, `RAGConfig.embeddingProvider`: `Embedder`, `embed` and `embedMany` from `@arki/embeddings`. `RAGConfig` now takes `embedder: Embedder`.
  - `OpenAIEmbeddingProvider`: `createOpenAIModel`. Nebius, TEI, vLLM: `createOpenAICompatibleModel`.
  - `MockEmbeddingProvider`: `fakeEmbedder` from `@arki/embeddings/testing`.
  - `buildQueryText`, `QWEN_QUERY_INSTRUCTION`: an `Instruction` on the model (`QWEN3_INSTRUCTION`, or your own) and `purpose: 'query'` on the call.
  - `openaiEmbeddingConfigSchema`, `mockEmbeddingConfigSchema`, `embeddingConfigSchema` and their types: each `@arki/embeddings` model options object has its own schema.
  - The `ai:embeddings` debug logger: use `getLogger('arki:embeddings')` (`DEBUG=arki:embeddings`).
  - Rerankers were removed in slice 8: `createCohereReranker`, `createVoyageReranker`, `createJinaReranker`, `createTeiReranker`, `createTransformersReranker`. The Bedrock and Mixedbread rerankers were not ported.
  - The Mixedbread embedding provider was not ported.

  Removed environment variables (read nowhere in `@arki/ai` now): `EMBEDDING_PROVIDER`, `OPENAI_EMBEDDING_MODEL`, `GOOGLE_EMBEDDING_MODEL`, `MISTRAL_EMBEDDING_MODEL`, `COHERE_API_KEY`, `COHERE_EMBEDDING_MODEL`, `COHERE_RERANK_MODEL`, `VOYAGE_API_KEY`, `VOYAGE_EMBEDDING_MODEL`, `VOYAGE_RERANK_MODEL`, `JINA_API_KEY`, `JINA_EMBEDDING_MODEL`, `JINA_RERANK_MODEL`, `NEBIUS_API_KEY`, `NEBIUS_EMBEDDING_MODEL`, `NEBIUS_EMBEDDING_DIMENSIONS`, `NEBIUS_BASE_URL`, `MXBAI_API_KEY`, `MXBAI_EMBEDDING_MODEL`, `MXBAI_RERANK_MODEL`, `OLLAMA_EMBEDDING_MODEL`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_MODEL`, `OPENAI_COMPATIBLE_DIMENSIONS`, `AWS_REGION`, `BEDROCK_EMBEDDING_MODEL`, `BEDROCK_RERANK_MODEL`, `TRANSFORMERS_JS_MODEL`. Read the ones you still need in your own app.

  Removed dependencies of `@arki/ai`: `@ai-sdk/amazon-bedrock`, `@ai-sdk/cohere`, and the optional peers `voyageai`, `@mixedbread-ai/sdk`, `@huggingface/transformers`.

  `fromArkiEmbedder(embedder)` turns an `@arki/embeddings` embedder into the embedder the `@arki/testing/ai` judge and `similarTo` take. A failure becomes a thrown `Error`. It lives in `@arki/embeddings/testing`, so the two packages depend one way only (embeddings → testing).

- 7f81cd5: Structured generation takes any Standard Schema instead of a Zod type. `generateStructuredData`, `generateStructuredDataFromMessages`, `generateCustom`, `batchGenerate` and `StructuredLLMProvider` now accept `S extends StandardSchemaV1` and return `SchemaOutput<S>`. The model is shown the schema's input JSON Schema; the result is the schema's output. A schema with no JSON Schema converter throws a `ConfigurationError` naming `withJsonSchema`.
  `AgentTool.inputSchema` is a Standard Schema (`StandardSchemaV1<unknown, TInput>`) that can emit JSON Schema. `useAIGeneration` `schema` option is a Standard Schema and the request body carries its input JSON Schema as `jsonSchema`.
- c7199a6: Zod schemas move to a new `@arki/ai/zod` entry. The capability, validation, transcription and structured-generation entries now expose plain TS types only, so their published types carry no Zod.

  Each public type is now written as a plain TS type and is the source. Its runtime schema stays in the package and is locked to it by an exact two-way type test (`src/zod.test.ts`, `src/transcription.test.ts`), so the two cannot drift.

  Breaking:

  - `@arki/ai/capabilities/ask` no longer exports `askQuestionSchema`. Import it from `@arki/ai/zod`. `AskQuestion` stays.
  - `@arki/ai/capabilities/queue` no longer exports `queueOrderSchema`. Import it from `@arki/ai/zod`. `QueueOrderInput` stays.
  - `@arki/ai/capabilities/podhop` no longer exports `hopSelectionSchema`. Import it from `@arki/ai/zod`. `HopSelection['language']` is now `keyof typeof podHopVoices` (the same four languages), and `selectPodHopMoments` returns `Promise<HopSelection>`.
  - `@arki/ai/capabilities/episode-analysis` no longer exports `transcriptDocumentSchema`, `passageSchema` or `analysisDocumentSchema`. Import them from `@arki/ai/zod` (the root `@arki/ai` still exports the first and the last).
  - `@arki/ai/ai-service/structured-generation` no longer exports `CommonSchemas`. Import it from `@arki/ai/zod`. Each `StructuredGenerator` task returns a plain result type.
  - `@arki/ai/validation` exports only the config and input types and `validateInput` / `validateInputAsync`. Its schemas (`qdrantConfigSchema`, `vectorProviderConfigSchema`, `searchSettingsSchema`, `searchOptionsSchema`, `ragServiceConfigSchema`, `aiServiceConfigSchema`, `generationOptionsSchema`, `documentSchema`, `documentsSchema`, `chatMessageSchema`) come from `@arki/ai/zod` or the root. `sanitizerConfigSchema` comes from `@arki/ai/safety` or the root.
  - `@arki/ai/transcription`: `transcribeDiarizedAudio` takes `{ deepgramKey: string; transcriptionModel?: string }`, the same shape as before, written as a plain type.

  Also: `DetectionPattern`, `PIIPattern` and `SanitizerConfig` (`./safety`) are plain TS types. As a result `./dot`, `./react` and `./react/index` no longer expose Zod, and their baseline entries are removed.

  docs: README `Public imports` (`./validation`, `./zod`), `docs/reference.md`, `llms.txt` regenerated.
  no demo impact: no demo imports these schemas.

- 2c57c1c: Share bounded Web Crypto generation across modern and legacy IDs. Legacy
  `createId`, `createPrefixedId`, and factory `create`/`make`/`new` now return exact
  canonical generation failures. Preserve stored formats and prefixes, including
  legacy empty and punctuation prefixes, while removing the Cuid2 fallback to
  `Math.random`. Infer stored types from the successful schema and handle failures
  before side effects or string interpolation.

  Modern declarations use `defineId` with `IdOf` inferred from the canonical schema.
  Payment ID factory exports become browser-safe declarations; use `idColumns`
  for their table helpers. Payment provider creates and billing persistence return
  generation failures; webhook adapters must check these before acknowledgement.
  AI tombstone columns use modern declarations. Flow stops on returned failures;
  use `createFlow<State, Context>()(config)` to infer the exact node failure union.
  Ordinary patches cannot disguise a canonical failure through structural typing.

- 2544e6c: The tombstone table now runs on SQLite (libSQL) as well as Postgres. `createTombstoneTable` takes a column kit instead of a `PgSchema`, and `@arki/ai/drizzle/sqlite` adds `sqliteTombstoneOutbox`, the SQLite twin of `tombstoneOutbox`. The Postgres table is unchanged: drizzle-kit sees no difference.

  Breaking: the first argument is a column kit, and the user-id type now comes from a value instead of a type argument, so the call takes no type arguments. Migrate `createTombstoneTable<UserId, 'vtmb_'>(schema, { name, idPrefix })` to `createTombstoneTable(pgColumns(schema), { name, idPrefix, userId: defineId('usr_') })`, with `pgColumns` from `@arki/db/pg` (use `pgColumns()` for no schema). Any declaration with a `schema` works as `userId`.

  SQLite limits: timestamps keep milliseconds, and `varchar` limits become `CHECK` constraints.

- c000457: One local-first env reader for embeddings, and the vector index as a library. `createEmbeddingRuntime(env)` resolves `EMBEDDING_PROVIDER`, else Ollama (`OLLAMA_BASE_URL` / `OLLAMA_HOST`), else OpenAI, else `null` — and passes the env it read to the provider it builds (`OLLAMA_HOST` now reaches Ollama). `resolveEmbeddingSelection`, `buildQueryText` (Qwen query prefix by model name), `createEmbedder` (query-side guard + observed-dimension memo), `createVectorIndex` (Qdrant when `QDRANT_URL`, else mock; `durable` flag) and `runVectorReconciliation` (tombstone drain + dimension migration + re-upsert; tombstones acknowledged only against a durable index; points re-checked after upsert and deleted when their row is no longer current). New entries: `@arki/ai/dot` (`vectorIndex` plugin providing `embedder` + `vectorIndex`) and `@arki/ai/drizzle` (`createTombstoneTable`, `tombstoneOutbox`), with `@arki/dot`, `@arki/db` and `drizzle-orm` as optional peers.

  Breaking: `createEmbeddingProviderFromEnv()` and the stub `createVectorSearchProviderFromEnv()` are removed, and `EMBEDDING_PROVIDER` no longer defaults to `mock` — unconfigured now means `null`, never a mock.

- b10825c: Reranking. `@arki/ai`'s rerankers are removed; use `@arki/embeddings`.

  - `@arki/embeddings/rerank`: `rerank(reranker, query, items, { text, topK?, onTooLong?, signal? })` splits the items over the reranker's `maxDocuments`, merges the scores and keeps `topK` after the merge, so a per-request cut never drops a global winner. Each hit carries the caller's item, its index and its score. `withRerankCache(reranker, store)` keeps one score per provider, model, revision, truncation, query and document. The `Reranker` type, `RERANK_PROVIDERS`.
  - Long documents: `onTooLong: 'fail'` (default) returns `InputTooLong` naming the item before any request; `'truncate'` lets the provider cut; `'split'` scores overlapping windows and keeps the best window's score.
  - Each reranker lives in its provider's entry: `createCohereReranker` and `createCohereCompatibleReranker` (Infinity, vLLM, llama.cpp) in `./cohere`, `createVoyageReranker` in `./voyage`, `createJinaReranker` in `./jina`, `createTransformersReranker` (bge-reranker-v2-m3 or Qwen3-Reranker-0.6B, in process) in `./transformers`, and `createTeiReranker` in the new `./tei` entry. All over plain `fetch` except the in-process one.
  - `@arki/embeddings/testing`: `fakeReranker({ scores?, seed?, maxDocuments?, maxInputTokens? })`.
  - `bench/quality/rerank.eval.ts` (`bun run eval:rerank`): nDCG@10 and MRR@10 uplift over the same dense top 50 on SciFact, NFCorpus and FiQA slices. `bench/rerank.bench.ts`: `rerank()` against raw Transformers.js on the same weights.
  - The package now lints with the `@arki/eslint-config/library` preset; `vectorsByIndex` and the sparse row sort no longer use `Array#toSorted`, which Hermes lacks.
  - `@arki/ai`: `embeddings.rerankers` (`CohereReranker`, `VoyageReranker`, `JinaReranker`, `TeiReranker`, `MixedbreadReranker`, `BedrockReranker`, `createReranker`) is removed. The Mixedbread and Bedrock rerankers are not ported: nothing used them. Move a TEI reranker to `createTeiReranker`, the others to the matching `@arki/embeddings` entry, and call them through `rerank()`.

  no demo impact: no demo uses reranking.

- d7e9886: Return canonical owned cancellation, deadline and provider/callback defect outcomes from async waits and concurrency. Preserve fulfilled Failure elements, heterogeneous result inference, joined work and late settlement observation; contain foreign scope-listener failures. Add default operation telemetry without changing callback execution or exposing private causes. Retire migrated exception-only exports and update callers and runtime examples. AI Flow propagates retry-wait defects unchanged; Clock docs clarify its existing supervised sleep contract.

  no demo impact: public examples and runtime smoke checks cover the changed behaviour; no separate demo application exists.

- 2c57c1c: Repair schema/type agreement across Drizzle validators, ID factories and AI configuration.

  Breaking: generated table validators no longer claim phantom `$type<T>` shapes. Use a runtime schema with `jsonColumn` and reuse it in explicit validator refinements for precise input/output types. Bare JSON columns retain the native runtime validator and its honest inferred type.

  Breaking: `createIdFactory(prefix)` infers its ID from the literal prefix; remove the former second type argument. Payments ID aliases now reflect the prefixes their generators already produce. Existing generated values and stored IDs are unchanged.

  Breaking: replace AI `SearchOptionsType` with `SearchSettings`, and `AIServiceConfigType` with `RAGServiceConfig`. The `@arki/ai/types` aliases use those same distinct names. Provider configuration and sanitizer patterns now share their actual validation schemas, preserving custom `RegExp` rules.

  See `docs/features/arki-framework/migrations/defined-once.md` for migration examples and compatibility notes.

- 3f59d08: Provider calls and streams return typed failures instead of throwing or looking successful.

  - Every provider call (`createLLMProvider`, the Anthropic, OpenAI, Ollama, Google, Groq, Mistral and OpenRouter services, the provider router, the tool-loop runtimes) maps what the AI SDK threw or streamed through one boundary. A 429 is `RateLimited` with its Retry-After wait, 401/403 or a missing key is `ProviderUnauthorized`, a content filter is `ContentFiltered`, a `length` or other non-`stop` finish is `IncompleteGeneration`, an unusable answer is `InvalidOutput`, a server or network error is `ProviderFailed` (also for Ollama's own client errors), an abort is `Cancelled`, and an unknown throw is `UnexpectedDefect`. `generateText`, `generateConversation`, `generateStructuredData` and their `*Result` forms return `T | ProviderFailure`; streams yield `string | ProviderFailure` and end at the failure.
  - Streams read `fullStream`: an `error` part, an `abort` part, a non-`stop` finish or a stream with no finish ends with a failure instead of a short, complete-looking text. The tool-loop runtimes (`createAiSdkRuntime`, `createMastraRuntime`) end a run with one `run:error` carrying the failure value, never `run:error` then `run:finish`.
  - The provider router never restarts a stream after its first chunk, returns `Cancelled`, `UnexpectedDefect` and refusals at once without tripping provider health, and ends with `AllProvidersFailed` (each provider's failure code, shortest Retry-After). `createProviderRouter` and `createDefaultProviderRouter` return `NoProviderConfigured` instead of throwing.
  - `transcribeDiarizedAudio` returns `RateLimited`, `ProviderUnauthorized`, `InvalidOutput`, `ProviderFailed`, `Cancelled` or `InvalidInput` instead of throwing.
  - Capabilities (`ask`, `episode-analysis`, `pips`, `podhop`, `queue`) return `UngroundedOutput` for model output not backed by its source, and `InvalidInput` for a bad transcript.
  - `OpenAIService` returns `InputBlocked` when the sanitizer blocks a prompt, and an explicit `0` temperature or `maxRetries` is kept (`??`, not `||`).
  - `CircuitBreaker.execute` returns `CircuitOpen`; `executeOrThrow`, `CircuitBreakerError` and `CircuitBreakerResult` are removed. Aborts and defects no longer count toward opening the breaker.
  - `Flow.run` returns `Cancelled`, `FlowTimedOut`, `FlowStepLimitReached` or `FlowNodeFailed` (type `FlowFailure`) instead of throwing `FlowError`; a broken flow definition still throws `FlowError`.
  - `SemanticSearchService` escapes query words before highlighting, returns `KeywordSearchUnavailable` for keyword mode with no keyword provider, and keys its cache on every option that changes the result shape. `RedisSearchCache.clear` deletes only its own keys (SCAN + DEL), never `FLUSHDB`, and reads values through a schema. `SearchAnalyticsCollector.import` checks stored data with `searchAnalyticsExportSchema` and returns `InvalidInput`.
  - Safety scanners copy caller patterns with `g` set and `y` cleared, so a pattern with no `g` flag or an empty match always ends, and `lastIndex` never carries between calls.
  - Pricing treats `Object.prototype` names as unknown models; `CostEstimator.createEstimate` returns the price `basis`. `BudgetManager` serializes spends per key, and a zero limit reports 0 or 100 percent, never `NaN`.
  - `createVectorIndex` returns `InvalidEnvironment` for a bad `QDRANT_URL` or `QDRANT_REPLICATION_FACTOR`. `QdrantVectorProvider` throws `VectorSearchError` at construction for a URL that does not parse, and `getDocument` returns `null` only for a missing point: a Qdrant error is no longer read as "not found". `MockVectorProvider` refuses a vector of the wrong size, as Qdrant does.
  - React hooks and SSE helpers keep the server's typed failure body, check responses with schemas, return `ConnectionLost` for a stream that ends without `run:finish`, and decode chunks with `{ stream: true }`.
  - `createFakeLLMProvider` (`@arki/ai/testing`) returns `InvalidOutput` for an answer the schema rejects and `UnexpectedDefect` for a call past the last scripted answer, like a real provider.
  - Removed: `validateInput` and `validateInputAsync` (use `parse` from `@arki/schema`), and `hasErrorMessage`.
  - New failures: `ai.unauthorized`, `ai.content_filtered`, `ai.incomplete`, `ai.invalid_output`, `ai.provider_failed`, `ai.cancelled`, `ai.all_providers_failed`, `ai.no_provider_configured`, `ai.connection_lost`, `ai.input_blocked`, `ai.ungrounded_output`, `ai.flow_timed_out`, `ai.flow_step_limit`, `ai.flow_node_failed`, `ai.circuit_open`, `ai.keyword_search_unavailable`. New exports: `PROVIDER_FAILURES`, `ProviderFailure`, `isProviderFailure`, `RUNTIME_FAILURES`, `RuntimeFailure`, `ProviderRouterFailure`, `CIRCUIT_OPEN_REASONS`.
  - `runVectorReconciliation` dependencies return `VectorStoreUnavailable` (`ai.vector_store_unavailable`) when their backend cannot be reached, so an outage is counted (`failed`, `phaseAError`) and retried next run, while a dependency that throws is a bug and ends the run instead of being counted. Affected: `ReconcileDeps.upsertPoint`/`deletePoints`, `ReconcileStore.listMismatched`/`listCurrent`/`stillCurrent`, `MismatchedRow.persistReembedded`, `TombstoneStore.list`/`remove`. New exports: `VectorStoreUnavailable`, `OrUnavailable`.
  - `@opentelemetry/api` is now a runtime dependency of `@arki/ai` (API only; with no SDK registered every span call does nothing). Spans from the `@arki/ai` tracer: `ai.reconcile` (with the run counts), `ai.vector.<upsert|search|search_sparse|scroll|delete|delete_batch|retrieve>` for each Qdrant call, `ai.transcribe`, and `ai.mastra.run_tool_loop`. A returned or thrown failure sets the span status to error and the `failure.code` attribute.

- 772ed58: A tool's `execute` may now return a failure from `@arki/failure` for an expected outcome, such as "city not found". The model gets `{ error: { code, message, remediation, data } }` as the tool result, so the remediation can steer its next call. The `output` schema check is skipped for a failure. The run emits a new event, `{ type: 'tool:failure', tool, failure }`, and `runtimeEventReducer` marks that tool call `failed` with its `failure`. A thrown error is still a `tool:error`. The AI SDK and Mastra runtimes behave the same. `toAiSdkToolSet` and `toMastraTools` take an optional `onFailure(toolCallId, failure)`. New type: `ToolFailure`. `@arki/chat-ui`'s `RuntimeConversation` shows a failed tool call as an error with the failure's message.
- 01b4678: An exhausted budget and a busy rate limit are now failures from `@arki/failure`, returned, never thrown. `BudgetManager.checkBudget(userId, costUsd)` returns `undefined` when every period has room, or `BudgetExceeded` (code `ai.budget_exceeded`, status 402, data `{ period, currentSpendUsd, remainingUsd }`) for the first period that would go over; the `{ allowed, rejectionReason, rejectedPeriod }` result and the `BudgetCheckResult` type are gone. `RateLimiter.execute(key, fn)` returns the value of `fn`, or `RateLimited` (code `ai.rate_limited`, status 429, data `{ retryAfterMs }`) when no slot frees up; the `{ success, data, error, retryAfterMs }` wrapper and the `RateLimitResult` type are gone. Functions from `createRateLimitedFunction` resolve to `RateLimited` instead of rejecting. Both definitions are exported from `@arki/ai`, and `BudgetExceeded` also from `@arki/ai/cost`.

  - The provider services (`OpenAIService`, `AnthropicService`, `GoogleService`, `GroqService`, `MistralService`, `OpenRouterService`) return `RateLimited` too, from `generateText`, `generateConversation`, `generateStructuredData`, `generateStructuredDataFromMessages`, `moderateContent` and `batchGenerate` (an item per refused prompt). `LLMProvider.generateText` / `generateConversation` resolve to `string | RateLimited`. The rate-limited streams (`OpenAIService.streamText` / `streamConversation`, `AnthropicService.streamConversation`) are now `Promise<AsyncGenerator<string> | RateLimited>`: await the call, check `RateLimited.is(...)`, then `for await`. `ProviderRouter.executeWithFallback`, `generateText` and `generateConversation` fall over to the next provider on `RateLimited` and return `ProviderResult<T> | RateLimited`, the shortest wait, only when no provider answered and one was rate limited. `moderateContent` no longer wraps a refusal in `GenerationError`. `RateLimitError` is removed; `GenerationError` and every other provider fault still throw.

- 0faf836: `@arki/embeddings`: a vector cache, telemetry events, a KV store and a Dot plugin. `@arki/ai`: `vectorIndex()` no longer provides `embedder`.

  - `withCache(embedder, store?, { strict?, namespace?, ttlMs? })`: answers repeated texts from a byte store. The key is a SHA-256 of the space id, purpose, size, dtype, truncation choice, namespace and exact text, so a model, size or prompt change misses. Cached inputs are filled and the rest go to the provider as one call, in order; `usage.cacheHits` counts the hits. `strict: true` (default) returns `InvalidOutput` for a cached value that does not fit the space; `strict: false` re-embeds it. A store that throws is a miss.
  - `memoryCacheStore({ maxEntries? })`: an in-process LRU that copies on set and on get.
  - `withTelemetry(embedder, { log?, recordInputs? })`: one `arki.embed` event per call with provider, model, dimensions, input count, tokens, requests, cache hits, duration and outcome. Input texts stay out unless `recordInputs: true`.
  - `@arki/embeddings/kv`: `kvCacheStore(kv, { prefix? })` stores cached vectors as base64 through an `@arki/kv` client.
  - `@arki/embeddings/dot`: `embeddings({ model?, cache?, resilience?, env? })` publishes `embedder: Embedder | null`, built once at boot. `model` takes a ref, a model record, an `Embedder` or a factory. A configuration that does not resolve logs once at `warn` and publishes `null`. `@arki/dot` is an optional peer.
  - `@arki/ai`: `vectorIndex()` no longer provides `embedder` and no longer reads the old embedding runtime. It takes `space` (an `EmbeddingSpace`, an `Embedder`, `null`, or a function returning one) and sizes the index from it; mount `embeddings()` from `@arki/embeddings/dot` for the embedder. The `runtime` option is gone.
  - `@arki/ai`: `ReconcileDeps` takes `space: EmbeddingSpace` in place of `targetDimensions` and `model`. `embedText` may return an `EmbedFailure`, which counts the row as failed. Re-embedded points record `model: space.model` and `space: spaceId(space)` (`VectorPointPayload.space` is new and optional).
  - Review fixes: the cache key hashes its fields as a JSON array led by a value-format version (`v1`), so a `|` in `namespace` can no longer collide with the text and a future value format misses instead of failing strict mode; the docs say a strict failure on a foreign value lasts until its TTL. `ReconcileDeps.embedText` returns `{ vector, space }`, and re-embedded points record that space, so a revision Ollama learns on the first call is recorded from the first run.

- d145ece: Smaller install and safer defaults. Removed unused `@ai-sdk/ui-utils`, `csv-parse` and `@t3-oss/env-core`; `vitest` is now a dev dependency. `@ai-sdk/react`, `react-markdown`, `remark-gfm` and `streamdown` are now optional peers: install them if you use `@arki/ai/react` or `@arki/ai/react/md` (`./md` moved to `./react/md`). The re-export shims `@arki/ai/google-genai`, `/ollama` and `/openrouter` are removed; import `@google/genai`, `ollama` and `@openrouter/ai-sdk-provider` directly. `LLM_PROVIDER` now accepts `ollama` and defaults to it (was `openai`). `SecureConfig` has no built-in fallback key: it throws without `encryptionKey` or `ENCRYPTION_KEY`, and the shared instance is now `getSecureConfig()`.
- 19bf607: The root entry is portable, every import path is an explicit entry, and the tombstone table takes any Standard Schema for its user id.

  Breaking:

  - The root `@arki/ai` no longer exports `selectPodHopMoments`, `HopSelection` or `HopTranscript`. Import them from `@arki/ai/capabilities/podhop`, a Node-only entry (it runs the macOS `say` command through `node:child_process`).
  - The `./*` and `./react/*` wildcard exports are gone. Only the paths in `package.json` `exports` resolve: `.`, `./react`, `./react/index`, `./react/md`, `./cost`, `./safety`, `./dot`, `./testing`, `./drizzle`, `./drizzle/sqlite`, `./env`, `./sdk`, `./anthropic`, `./google`, `./groq`, `./mistral`, `./openai`, `./mastra`, `./transcription`, `./validation`, `./runtime/index`, `./ai-service/types`, `./ai-service/structured-generation`, `./capabilities/ask`, `./capabilities/episode-analysis`, `./capabilities/pips`, `./capabilities/queue`, `./capabilities/podhop`. Any other deep path (for example `@arki/ai/debug`, `@arki/ai/errors`, `@arki/ai/vector-search/...`) no longer resolves; import the same names from the root.
  - `createTombstoneTable` (`./drizzle`, `./drizzle/sqlite`) takes `userId: { schema: StandardSchemaV1<unknown, TUserId> }` instead of a Zod type. A `defineId(...)` declaration still works unchanged; a Valibot or ArkType schema now works too. `TUserId` is still inferred, so callers write no type arguments.

  Other changes:

  - The Qdrant provider derives point ids with WebCrypto (`crypto.subtle.digest('SHA-1', ...)`) instead of `node:crypto`. The ids are byte-identical, so stored points keep their ids (a golden test locks them).
  - A test bundles the root entry for the browser and fails if any file it reaches imports a Node built-in.

  docs: README `Public imports` lists every entry; `llms.txt` regenerated.
  no demo impact: no demo imports podhop, a removed deep path, or `createTombstoneTable`.

- ed02a2e: The agent runtime can now be cancelled, and tools can declare the shape of what they return.

  - `runToolLoop` takes an optional `signal`. Once it aborts, the run starts no new model call or tool call, the model call in flight is aborted, and the loop rejects with the signal's reason. Both the AI SDK and the Mastra runtime honour it.
  - A tool's `execute` now gets a second argument, `{ signal }`. Pass it to `fetch` and other slow work.
  - A tool can declare `output` (Zod or any Standard Schema). The runtime checks the result against it before the model sees it. A mismatch fails the tool call with a new `ToolOutputError` (code `TOOL_OUTPUT_ERROR`).
  - New `defineAgentTool` helper: `execute`'s input type comes from `inputSchema` and its return type from `output`.
  - The AI SDK runtime records one span per model step and one per tool call through the AI SDK's own telemetry, when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Nothing changes without it.
  - `aiTelemetry` no longer throws where there is no `process` (browsers, Hermes).

- c7b7785: `@arki/ai` closes the gaps the demos found. All additions; existing calls keep their types and answers.

  - **Usage in results.** `createLLMProvider()` now returns `LLMProviderWithUsage`, a `StructuredLLMProvider` that also names its `provider` and `model` and has `generateStructuredResult` and `generateTextResult`. They make the same calls and return `{ value, usage: { inputTokens, outputTokens }, provider, model }`.
  - **Spans without OTLP.** Generation calls report `gen_ai` spans whenever an OpenTelemetry tracer provider is registered, not only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. `AI_TELEMETRY=off` turns them off.
  - **Provider probe.** `probeLLMProvider()` checks the provider `createLLMProvider` would use: Ollama answers and has the model, an OpenAI-compatible `baseURL` answers, or a cloud key is set. It returns the new `ProviderUnavailable` failure (`ai.provider_unavailable`, data `{ provider, model, problem }`) instead of throwing. `LLM_PROVIDERS` and `resolveLlmProvider` are exported too.
  - **Local pricing.** `priceOf({ provider, model, inputTokens, outputTokens })` returns `{ usd, basis }`: a local provider (`ollama`) costs 0 with `basis: 'local'`; an unknown hosted model keeps the default rate with `basis: 'default-rate'`. `calculateLLMCost` takes an optional `{ provider }` and returns 0 for a local one; without it the answer is unchanged.
  - **Fake provider.** `@arki/ai/testing` exports `createFakeLLMProvider`: scripted answers and usage, no HTTP, with the real schema check.
  - **Dot plugin.** `llm(...)` from `@arki/ai/dot` publishes the provider as `llm`. `dot explain` lists it; by default it probes at boot, so an unusable provider fails boot with `ProviderUnavailable` and `dot doctor` marks the plugin failed. `probe: false` boots without a model; `instance` injects a provider such as the fake.

  Demo impact (the demos are not changed now; these workarounds become redundant when they adopt this release):

  - `drop-studio` lib-gaps #22: `backend/src/ai/telemetry.ts` (its own `registerTelemetry` integration) — read `usage` from `generateStructuredResult`, and the `gen_ai` spans now reach its X-ray tracer provider without it. Because the demo registers a tracer provider, its X-ray rail will also show `@arki/ai`'s `gen_ai` spans, prompts and completions included; set `AI_TELEMETRY=off` to keep today's view.
  - `drop-studio` #23 and `faultline` #7: `backend/src/ai/probe.ts` — `probeLLMProvider`.
  - `drop-studio` #24: `costOf` in `backend/src/ai/telemetry.ts` — `priceOf`.
  - `drop-studio` #27: `backend/src/ai/fake-ollama.ts` — `createFakeLLMProvider` for in-process tests. The e2e runs, where the backend is a separate process, still need the fake HTTP server.
  - `drop-studio` #28: no `llm` plugin — `llm(...)`.
  - `faultline` imports `@arki/ai` and registers an X-ray tracer provider too, so the same `gen_ai` spans appear in its rail.

- cac4bc6: Jina, Bedrock, image inputs and sparse vectors.

  - `@arki/embeddings/jina`: `createJinaModel({ id?, apiKey, baseURL?, fetch? })` over plain `fetch`, `jina-embeddings-v3` (1024 dims, sizes 1–1024, `task` from the purpose, truncation off unless asked).
  - `@arki/embeddings/bedrock`: `createBedrockModel(…)` through `@ai-sdk/amazon-bedrock` (optional peer, Node and Bun), Amazon Titan Text Embeddings V2 (1024/512/256).
  - Image inputs: `{ image, mimeType?, text? }` reaches a provider through the new optional `EmbeddingModel.embedInputs` (`NativeInput`, `NativeInputsRequest`); the media type is read from the bytes when left out; a model that cannot take images refuses before any request. `gemini-embedding-2`, Cohere `embed-v4.0` and Voyage `voyage-multimodal-3.5`/`voyage-multimodal-3` take images.
  - `@arki/embeddings/sparse`: `createSparseModel` over TEI `/embed_sparse` (SPLADE). `SparseSpace` carries the tokenizer `vocabulary`; a vocabulary mismatch is `SpaceMismatch`. New provider name `tei`.
  - `resolveEmbeddingModel` builds Jina (`JINA_API_KEY`) and Bedrock (`AWS_REGION` and AWS credentials from the env passed in) when named.
  - `@arki/ai`: `QdrantVectorProvider` takes `sparseSpace`, stores a named sparse vector next to the dense one (`upsertVector(id, vector, metadata, sparse)`) and adds `searchBySparseVector`. Dense-only collections are unchanged.

- 9bb74f0: First public release of `@arki/ai`: local-first generation, embeddings, a vector index with erasure, and a tool-loop runtime. The package will be split into smaller packages in later minor releases.

### Patch Changes

- 4222ad1: `@arki/ai/react` now exports `initialRuntimeUiState`, `runtimeEventReducer` and the types `useRuntimeStream` speaks (`RuntimeUiState`, `RuntimeToolCall`, `RuntimeUiStatus`, `RuntimeEvent`, `RuntimeUsage`, `ToolFailure`). Browser code that folds or names runtime state imports them from the react entry instead of the root, which also carries server-only providers (the Qdrant provider reads `node:crypto`) and crashed a browser bundle. A test bundles the react entry for the browser and fails if it pulls in the vector-search providers.

  no docs impact: `llms.txt` import paths regenerated; the README documents entries, not their member lists.
  no demo impact: no demo uses the runtime reducer.

- 7533a49: Deterministic mode: `createLLMProvider({ deterministicSeed })`, or env `AI_DETERMINISTIC_SEED`, runs every call at temperature 0 with that seed (overriding any per-call temperature), so a real local model answers one input the same way run after run. `new OllamaService({ deterministicSeed })` follows the same rule (same env default). Meant for tests; providers that honour a seed (Ollama does) become repeatable. (The code shipped in 3ab611cf9b; this records it.)
- e132ad3: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

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

- bcc641a: User-scoped Anthropic keys (`sk-ant-usr…`) work. Anthropic rejects every request from such a key unless it names a workspace. Set the new optional env var `ANTHROPIC_WORKSPACE_ID` and every Anthropic provider `@arki/ai` builds sends the `anthropic-workspace-id` header: `createLLMProvider`, `AnthropicService` and the provider router. `@arki/ai/anthropic` now exports its own `createAnthropic` and `anthropic`, which add the header. Workspace-scoped keys need nothing, and the header is left off.
- 48313a3: Fix the AI react/index wildcard target to resolve its existing TypeScript source. Remove Geo exports and typesVersions entries for unimplemented Apple, Mapbox, Leaflet and HERE modules; these paths never resolved. Google Maps and geocoding exports remain supported.
- 972c014: The Anthropic default model is now `claude-sonnet-5-5` (was `claude-3-5-haiku-latest` in `createLLMProvider`, `claude-3-5-sonnet-latest` in `AnthropicService`, `claude-3-haiku-20240307` in the provider router). `LLM_MODEL` still overrides it. New exports: `DEFAULT_ANTHROPIC_MODEL` and `resolveLlmModel()`, which returns the model id `createLLMProvider` would use.
- 49517e2: The build no longer compiles type tests (`*.test-d.ts`). They stay in `typecheck`, but a type test can no longer fail the build, and the published `dist` no longer holds compiled type tests.

  `@arki/db` exports the `OnDelete` type from `@arki/db/id` and `@arki/db/sqlite`. A package whose types come from `idColumns` (such as `@arki/auth`) can now build its declarations. Before, TypeScript could not name `OnDelete` and stopped with TS2883.

  `@arki/ai` drops a `@ts-expect-error` above the `@huggingface/transformers` import. That package is now always installed, so the comment had no error to hide and failed the build.

- e132ad3: Document actionable fixes and verification commands for canonical error definitions.

  Journal command/workflow failures and Embeddings failures also expose the missing runtime remediation guidance. Existing failure codes, data and inferred unions are unchanged.

- Updated dependencies [a6cae86]
- Updated dependencies [86d6562]
- Updated dependencies [779194e]
- Updated dependencies [9b65562]
- Updated dependencies [f8a0e13]
- Updated dependencies [440c75f]
- Updated dependencies [36e475d]
- Updated dependencies [b10825c]
- Updated dependencies [115edae]
- Updated dependencies [7c8ab60]
- Updated dependencies [e132ad3]
- Updated dependencies [e80211d]
- Updated dependencies [087023b]
- Updated dependencies [b992897]
- Updated dependencies [aa101f2]
- Updated dependencies [0faf836]
- Updated dependencies [e132ad3]
- Updated dependencies [71de1af]
- Updated dependencies [cac4bc6]
- Updated dependencies [46129c8]
- Updated dependencies [cac4bc6]
- Updated dependencies [ba05496]
- Updated dependencies [11c5bc2]
  - @arki/embeddings@0.1.0

## 0.1.3

### Patch Changes

- Updated dependencies
  - @arki/contracts@0.0.2
  - @arki/log@0.0.2
  - @arki/env@0.0.3

## 0.1.2

### Patch Changes

- Updated dependencies
  - @arki/env@0.0.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @arki/contracts@1.0.0
  - @arki/log@1.0.0
