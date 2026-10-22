---
'@arki/embeddings': minor
---

EmbeddingGemma 2 in `./transformers`, and the quality eval.

- `createTransformersModel({ id: 'onnx-community/embeddinggemma-2-ONNX' })` knows EmbeddingGemma 2 (Apache-2.0): pinned to one commit, 768 dims with Matryoshka sizes 512/256/128, 8,192 input tokens, and its own `EMBEDDINGGEMMA_2_INSTRUCTION` (the same prefixes as EmbeddingGemma today, versioned apart). The in-process default stays EmbeddingGemma 300M until the Romanian gate can run.
- `bench/quality.eval.ts` (`bun run eval`): nDCG@10, recall@10/50 and MRR@10 on SciFact and NFCorpus, Spearman on RO-STS, a BM25 floor, gate D1, and a wrapper-vs-raw self-check. It reads any folder in the BEIR shape with `--dataset`.
