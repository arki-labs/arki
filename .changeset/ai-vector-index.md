---
'@arki/ai': minor
---

One local-first env reader for embeddings, and the vector index as a library. `createEmbeddingRuntime(env)` resolves `EMBEDDING_PROVIDER`, else Ollama (`OLLAMA_BASE_URL` / `OLLAMA_HOST`), else OpenAI, else `null` — and passes the env it read to the provider it builds (`OLLAMA_HOST` now reaches Ollama). `resolveEmbeddingSelection`, `buildQueryText` (Qwen query prefix by model name), `createEmbedder` (query-side guard + observed-dimension memo), `createVectorIndex` (Qdrant when `QDRANT_URL`, else mock; `durable` flag) and `runVectorReconciliation` (tombstone drain + dimension migration + re-upsert; tombstones acknowledged only against a durable index; points re-checked after upsert and deleted when their row is no longer current). New entries: `@arki/ai/dot` (`vectorIndex` plugin providing `embedder` + `vectorIndex`) and `@arki/ai/drizzle` (`createTombstoneTable`, `tombstoneOutbox`), with `@arki/dot`, `@arki/db` and `drizzle-orm` as optional peers.

Breaking: `createEmbeddingProviderFromEnv()` and the stub `createVectorSearchProviderFromEnv()` are removed, and `EMBEDDING_PROVIDER` no longer defaults to `mock` — unconfigured now means `null`, never a mock.
