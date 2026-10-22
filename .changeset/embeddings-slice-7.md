---
'@arki/embeddings': minor
'@arki/ai': minor
---

Jina, Bedrock, image inputs and sparse vectors.

- `@arki/embeddings/jina`: `createJinaModel({ id?, apiKey, baseURL?, fetch? })` over plain `fetch`, `jina-embeddings-v3` (1024 dims, sizes 1–1024, `task` from the purpose, truncation off unless asked).
- `@arki/embeddings/bedrock`: `createBedrockModel(…)` through `@ai-sdk/amazon-bedrock` (optional peer, Node and Bun), Amazon Titan Text Embeddings V2 (1024/512/256).
- Image inputs: `{ image, mimeType?, text? }` reaches a provider through the new optional `EmbeddingModel.embedInputs` (`NativeInput`, `NativeInputsRequest`); the media type is read from the bytes when left out; a model that cannot take images refuses before any request. `gemini-embedding-2`, Cohere `embed-v4.0` and Voyage `voyage-multimodal-3.5`/`voyage-multimodal-3` take images.
- `@arki/embeddings/sparse`: `createSparseModel` over TEI `/embed_sparse` (SPLADE). `SparseSpace` carries the tokenizer `vocabulary`; a vocabulary mismatch is `SpaceMismatch`. New provider name `tei`.
- `resolveEmbeddingModel` builds Jina (`JINA_API_KEY`) and Bedrock (`AWS_REGION` and AWS credentials from the env passed in) when named.
- `@arki/ai`: `QdrantVectorProvider` takes `sparseSpace`, stores a named sparse vector next to the dense one (`upsertVector(id, vector, metadata, sparse)`) and adds `searchBySparseVector`. Dense-only collections are unchanged.
