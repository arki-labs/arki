---
'@arki/ai': minor
'@arki/testing': minor
---

Embedding providers removed; use `@arki/embeddings`.

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

Migration ledger (files that used the old embedding API, and the slice that moved each):

- tolstoyco, slice 0: `apps/tolstoyco/backend/src/features/ai/rag/index-content.ts`, `apps/tolstoyco/backend/src/features/ai/rag/retriever.ts`.
- text-bible search, slice 0: `fleet/text-bible/src/search/passage-search.ts`.
- everseek, slices 1 and 5: `apps/everseek/backend/src/features/ai/services/semantic-bible-search.ts`, `src/features/bible/procedures/index-embeddings.ts`, `src/features/bible/procedures/explain-passage.ts`, `src/features/bible/lib/explain-semantic-cache.ts`, `src/features/bible/spikes/cag-evaluation/hybrid.ts`, `src/features/bible/__tests__/retrieval-infra.smoke.test.ts`, `src/scripts/seed-embeddings.ts`, `src/env.ts`.
- loonyjobs, slices 1 and 4: `apps/loonyjobs/backend/src/features/embeddings/{provider.ts,index.ts,jobs/index.ts,worker.ts,repository.ts}`, `src/schema/job-embeddings.ts`, `__tests__/embeddings.test.ts`, and the migrations in `apps/loonyjobs/backend/migrations/`.
- avocabo, slice 2: `apps/avocabo/backend/src/features/vector-index/infra/vectors.ts`, `features.ts`, the `feature.ts` of vector-index, vector-sync, semantic-search, highlights, content-deduplication, ai-copilot, auto-clustering, library and account, `vector-sync/infra/{reconciler.ts,reconcile-deps.ts}`, `semantic-search/usecases/{search-index-service.ts,index-new-items.ts,search.ts}`, `highlights/usecases/{create.ts,get-related.ts,highlight-processing.ts,search.ts}`, `content-deduplication/infra/embedder.ts`, `content-deduplication/usecases/{dedupe-ready-items.ts,similarity-search.ts}`, `ai-copilot/usecases/{rag-retrieval-service.ts,reactive-handler.ts,stream-answer.ts}`, `auto-clustering/usecases/{assign-new-items.ts,batch-recluster-service.ts,cluster-assignment-service.ts}`, and their 12 `__tests__` files. The last file moved, `apps/avocabo/backend/src/infra/vectors/__tests__/embedder.test.ts`, now pins the old runtime's choices as fixed values.
- text-bible original languages, slice 3: `fleet/text-bible/package.json`, `fleet/text-bible/src/original-languages/embeddings/generator.ts`, `fleet/text-bible/src/original-languages/api/index.ts`.
- `@arki/testing/ai`, slice 9: `packages/testing/src/ai/{index.ts,judge.ts,ai.test.ts}`.
- Root catalog `ai` (`@huggingface/transformers`): slice 3.
