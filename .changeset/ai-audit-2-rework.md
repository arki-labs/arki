---
"@arki/ai": minor
---

Breaking: `SemanticSearchService.indexDocuments` returns `VectorStoreUnavailable` (`ai.vector_store_unavailable`, operation `index`) when the vector store refuses a write, instead of throwing the client's error. Every write of the failed batch settles first; the `reason` says how many documents were written. Indexing the same documents again is safe. Its result type adds `VectorStoreUnavailable`.

- `indexDocuments` throws (`invariant`) before embedding anything when the store holds a sparse vector per point (`sparseSpace`): it builds dense vectors only, so every write was refused.
- Breaking: `QdrantVectorProvider` hashes an all-digit id past `Number.MAX_SAFE_INTEGER` into a UUID point id, like any other non-integer id. Such ids used to round to one number, so `"12345678901234567890"` and `"12345678901234567891"` overwrote each other. Re-index documents with such ids; points stored under the rounded number are no longer addressed.
