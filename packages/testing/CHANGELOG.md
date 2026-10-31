# @arki/testing

## 0.3.0

### Minor Changes

- e6b9330: `@arki/testing`: `readManifest` returns `StackNotStarted` or `StackManifestInvalid` (`testing.stack_not_started`, `testing.stack_manifest_invalid`) instead of throwing; the manifest text is checked by a schema. The judge and embedder (`createJudge`, `createEmbedder`) return or raise `OllamaUnavailable` and `OllamaAnswerInvalid` (`testing.ollama_unavailable`, `testing.ollama_answer_invalid`), and the judge scorers turn a judge failure into an `unscorable` score. `setupGlobalTestContainers`, `stackSetup`, the `e2eTest` server fixture, `defineStack` and `RunningStack.stop` always stop what they started, even when a later step or a stop fails. `IntegrationTester.withTransaction` no longer swallows a lost connection. New `serveWorker` helper for the e2e server fixture.

  `@arki/contracts`: the root doc comment says which doors throw and which return; extra tests for `defineId().is` and `operationAt`.

  `@arki/intl`: `loadMessagesFromMultipleDictionaries` and `AppLocaleProvider` look locales up by own key, so `'__proto__'`, `'toString'` or `'constructor'` fall back to the default locale instead of throwing or merging prototype members.

### Patch Changes

- Updated dependencies [7c8ab60]
  - @arki/kv@0.5.0
  - @arki/auth@0.3.1
  - @arki/db@0.5.1

## 0.2.0

### Minor Changes

- Publish compiled JavaScript in `dist/`; every export entry now imports under plain Node from the npm tarball.
- 0de045c: `import '@arki/testing'` no longer needs Docker, msw or `@arki/auth`. The root now holds only factories, assertions, timestamps, debug and performance helpers. `initTester` moved to `@arki/testing/tester-builder`. `IntegrationTester` and the tester types (`TestUser`, `TesterUsers`, `TesterOptions`, `IntegrationTesterConfig`) moved to `@arki/testing/integration-tester`. `setupGlobalTestContainers` and the container helpers moved to `@arki/testing/containers`. The `./types` entry is gone. `@arki/auth`, `testcontainers`, `@testcontainers/postgresql`, `@testcontainers/redis` and `msw` are now optional peer dependencies; install the ones the entries you use need.
- 472cbb1: `assertTimestampRecent` now accepts a `Date`, an `Instant` or a `ZonedDateTime`, like `assertTimestamps`, and narrows to `Timestamp`. `generateDate({ between })` takes the same three kinds for its bounds. `timestamps.ts` also exports `isTimestamp`, `describeKind`, `epochNanoseconds` and `epochMilliseconds`.
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

- 1971bad: `initTester` no longer erases types, and the package has no unsafe casts left. `tester.db` and `tester.repo` now have the types of the functions you pass to `create`: the database type comes from `createDatabase`, the repository type from the return value of `createRepositories`, and the schema type from `schema`. Before, they were `any` in every app test.

  Breaking: the config has a new required hook, `createDatabase(connectionString)`. The app builds its own database (same relations as production), so the type of `tester.db` comes from one place and relational queries work in tests. This replaces overriding `createDatabaseConnection`, which is gone. The tester still runs migrations and creates the unique test database on its own short-lived connection built from `schema`.

  Breaking: `IntegrationTesterConfig` and `IntegrationTester` take a sixth type parameter, `THandle`: what `createRepositories` and `createContext` receive, the root database or the transaction of `withTransaction` (for example `Db | Transaction`). Type the `db` parameter of `createRepositories` with it. The tester can then swap the database for the transaction without a cast. `tester.db` stays the root database (with its `$client`), `currentTx` is `THandle | null`, and `TesterDatabase<THandle>` is the constraint. `TesterConfig` takes `<TSchema, TDatabase, TRepositories, TContext, TCaller, THandle>`.

  Breaking: factories. The `baseFactories` config option, `tester.factory.register`, `setFactoryRegistry` and the fallback registry are gone. `t.tester.withFactories(factories)` puts the exact object you pass on `tester.factory`; `t.tester.create()` returns a tester with no `factory`. `FactoryRegistry` is now built from a map (`new FactoryRegistry({ user: userFactory })`) and looks factories up by name: `create('user')` is a `User`, an unknown name or a wrong override does not compile. It has `has`, `get`, `create` and `createMany`; `register`, `clear` and `TypedFactoryRegistry` / `TypedFactoryRegistryInstance` are removed.

  Fix: `Factory<T>` had its call signatures in the wrong order, so `factory()` was typed `T` while it returns a `FactoryBuilder<T>` at runtime (and in the docs). `factory()` is now typed `FactoryBuilder<T>`, `factory(overrides)` is `T`. Call sites that used `factory()` as the object must call `factory().build()`; the compiler now finds them.

  Fix: `asUser()`, `asModerator()`, `asAdmin()`, `asGuest()`, `withUser()`, `createUser()` and `tester.caller.*` build their callers on the current database, so inside `withTransaction` they write through the test transaction. Before, they used callers built at setup on the base connection, which skipped the transaction and could wait forever on a lock the transaction held. Read `tester.caller` inside the transaction; a caller kept from before it still uses the base connection.

  The rest of the package no longer uses `any` either. `IntegrationTester` closes database connections, reads `closeEventStore`, and finds tables in the schema (with Drizzle's `is(table, PgTable)`) by checking at runtime instead of casting. The debug helpers, `assertErrorThrown`, `assertNoError`, `comparePerformance` and `baseFactories` take `unknown` instead of `any`. `assertDeepPartialMatch` takes `unknown` and reports a missing property when the actual value is not an object. `createFactory` has real overloads instead of a cast.

  Breaking: `withTransaction` returns `Promise<void>` (it always rolled back and returned `undefined`, so its old `Promise<T>` was a lie). `seed` takes `Record<string, readonly object[]>`, and a name in the schema that is not a table now throws "not found". `assertContainsId` and `assertNotContainsId` need a field name when the items have no `id`. `assertArraySorted` throws when it cannot order two values (it only orders numbers, bigints, strings and dates) instead of passing silently. `TypedFactoryRegistry` has an `unknown` index signature instead of `any`; use `TypedFactoryRegistryInstance` for typed access.

  Fix: `withTransaction` never rolled back. It threw its rollback sentinel inside the Drizzle transaction callback and then caught it there, so the callback returned normally and the transaction committed. The sentinel is now thrown after the callback, outside any catch, so Drizzle always rolls back, whether the callback resolves or throws. An error thrown by the callback is rethrown unchanged after the rollback. Tests that relied on data committed by an earlier test must set up their own data, and writes inside the callback must go through `tester.currentDb` (or `tester.repo`, callers), not `tester.db`, which is the base connection and cannot see uncommitted rows.

- 034a60f: First public release of `@arki/testing`: test containers, an integration tester, typed factories, assertions, MSW mocking and AI scorers. no demo impact: `@arki/testing` is a dev dependency that no registered demo (`drop-studio`) imports.
- e3cf0f6: `assertTimestamps` and `assertUpdatedAfterCreated` accept `Date`, Temporal `Instant` and `ZonedDateTime` timestamps, and compare them by exact epoch nanoseconds. `assertTimestamps` now narrows to `Timestamps` (`{ createdAt: Timestamp; updatedAt: Timestamp }`, where `Timestamp = Date | Instant | ZonedDateTime`) instead of `{ createdAt: Date; updatedAt: Date }`. Both functions are also exported on their own, with the `Timestamp` and `Timestamps` types. An invalid `Date` is now rejected. `@arki/testing` depends on `@arki/date`.

### Patch Changes

- 2c57c1c: Return exact ID generation failures from `defineId` and Auth generators, preserving
  successful prefixes and schema types. Validate and bound the entropy provider
  protocol; retain private causes and observe malformed asynchronous output.

  Propagate failures through modern consumers. Drizzle scalar defaults bridge at
  the foreign callback, while owned transactions restore canonical identity and
  roll back without replaying a returned refusal. FS upload creation returns before
  I/O and declares the same failure tuple in its native RPC contract.

  Handle `isFailure(id)` before using a generated ID. Derive stored ID types from
  the declaration or schema, not the generator's `ReturnType`. See Contracts'
  `docs/upgrades/typed-ids.md`. Legacy DB generators remain unchanged pending their
  separate consumer migration.

- e132ad3: Hand-written object guards now come from `@arki/schema` (`is(value, recordSchema)` or `plainObjectSchema`), per A-39. Replaced: the `isRecord`/`isPlainObject`/`isObject` helpers in `dot`, `cli`, `http`, `expr`, `lock`, `mail`, `embeddings` (its internal `isRecord`, not a public export), `testing` and `payments`, plus inline `typeof x === 'object' && x !== null` checks on unknown values. Behaviour is the same, except that the inline checks and `lock`'s guard no longer let arrays through. `@arki/expr` and `@arki/lock` now depend on `@arki/schema`.
- 8f873ae: Replace the `"./*"` wildcard export with one explicit entry per module: `assertions`, `containers`, `debug`, `factories`, `integration-tester`, `msw`, `performance`, `tester-builder`, `timestamps`, `types` and `vitest-setup`. Every existing import specifier still resolves.
- 2be84c9: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

- Updated dependencies [b992897]
- Updated dependencies [ebc681b]
- Updated dependencies [49deeb6]
- Updated dependencies [6cc8655]
- Updated dependencies [ff85471]
- Updated dependencies [440c75f]
- Updated dependencies [5d55e12]
- Updated dependencies [be8f8e2]
- Updated dependencies [1e47612]
- Updated dependencies [e132ad3]
- Updated dependencies [49517e2]
- Updated dependencies [8944628]
- Updated dependencies [164e25a]
- Updated dependencies [5d55e12]
- Updated dependencies [29520c1]
- Updated dependencies [b37115d]
- Updated dependencies [36b4da8]
- Updated dependencies [530b86a]
- Updated dependencies [b435e76]
- Updated dependencies [517d297]
- Updated dependencies [9d408cf]
- Updated dependencies [e80211d]
  - @arki/db@0.5.0
  - @arki/auth@0.3.0
  - @arki/kv@0.4.0

## 0.1.3

### Patch Changes

- Updated dependencies
  - @arki/log@0.0.2
  - @arki/db@0.1.2
  - @arki/kv@0.1.2
  - @arki/auth@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies
  - @arki/kv@0.1.1
  - @arki/db@0.1.1
  - @arki/auth@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @arki/log@1.0.0
  - @arki/db@0.1.1
  - @arki/auth@0.1.1
  - @arki/kv@0.1.1
