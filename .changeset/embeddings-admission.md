---
'@arki/embeddings': minor
---

First public release of `@arki/embeddings`: one `Embedder` shape over Ollama, OpenAI and OpenAI-compatible servers, with checked output, failures as values and spaces that stop mixed vectors.

no demo impact: drop-studio, the only registered demo, does not import `@arki/embeddings`; it reaches it only through `@arki/ai`, which the `@arki/ai` admission changeset covers and whose public API this release does not change.
