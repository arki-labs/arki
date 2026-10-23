---
'@arki/embeddings': minor
'@arki/ai': minor
---

Reranking. `@arki/ai`'s rerankers are removed; use `@arki/embeddings`.

- `@arki/embeddings/rerank`: `rerank(reranker, query, items, { text, topK?, onTooLong?, signal? })` splits the items over the reranker's `maxDocuments`, merges the scores and keeps `topK` after the merge, so a per-request cut never drops a global winner. Each hit carries the caller's item, its index and its score. `withRerankCache(reranker, store)` keeps one score per provider, model, revision, truncation, query and document. The `Reranker` type, `RERANK_PROVIDERS`.
- Long documents: `onTooLong: 'fail'` (default) returns `InputTooLong` naming the item before any request; `'truncate'` lets the provider cut; `'split'` scores overlapping windows and keeps the best window's score.
- Each reranker lives in its provider's entry: `createCohereReranker` and `createCohereCompatibleReranker` (Infinity, vLLM, llama.cpp) in `./cohere`, `createVoyageReranker` in `./voyage`, `createJinaReranker` in `./jina`, `createTransformersReranker` (bge-reranker-v2-m3 or Qwen3-Reranker-0.6B, in process) in `./transformers`, and `createTeiReranker` in the new `./tei` entry. All over plain `fetch` except the in-process one.
- `@arki/embeddings/testing`: `fakeReranker({ scores?, seed?, maxDocuments?, maxInputTokens? })`.
- `bench/quality/rerank.eval.ts` (`bun run eval:rerank`): nDCG@10 and MRR@10 uplift over the same dense top 50 on SciFact, NFCorpus and FiQA slices. `bench/rerank.bench.ts`: `rerank()` against raw Transformers.js on the same weights.
- The package now lints with the `@arki/eslint-config/library` preset; `vectorsByIndex` and the sparse row sort no longer use `Array#toSorted`, which Hermes lacks.
- `@arki/ai`: `embeddings.rerankers` (`CohereReranker`, `VoyageReranker`, `JinaReranker`, `TeiReranker`, `MixedbreadReranker`, `BedrockReranker`, `createReranker`) is removed. The Mixedbread and Bedrock rerankers are not ported: nothing used them. Move a TEI reranker to `createTeiReranker`, the others to the matching `@arki/embeddings` entry, and call them through `rerank()`.

no demo impact: no demo uses reranking.
