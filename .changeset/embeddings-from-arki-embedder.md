---
'@arki/embeddings': patch
---

Add `fromArkiEmbedder(embedder)` to `@arki/embeddings/testing`, moved from `@arki/testing/ai`. It turns any embedder into the embedder that `similarTo` and the judge of `@arki/testing/ai` take. Texts go in as `purpose: 'document'`; a failure becomes a thrown `Error` with the failure's message. `@arki/testing` is a new optional peer, used for types only.

no demo impact: no demo uses `fromArkiEmbedder`.
