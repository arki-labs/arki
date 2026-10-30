---
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
