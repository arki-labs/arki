---
'@arki/embeddings': minor
'@arki/ai': minor
---

`@arki/embeddings`: first API: EmbeddingModel, EmbeddingSpace, createEmbedder, embed, embedMany, ./ollama, ./openai, ./openai-compatible, ./env, ./testing. Every result carries a space id; output is validated (count, dimensions, finite, non-zero norm) and failures are values.

`@arki/ai`: vector stores take vectors and `{ space }`; text-in methods removed; `scroll` added.
