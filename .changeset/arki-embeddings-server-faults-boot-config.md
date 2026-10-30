---
'@arki/embeddings': minor
---

Server faults and bad configuration are told apart from bad answers. Breaking in 0.x.

- A provider answer with status 500 or above is now `ModelUnavailable { reason: 'unreachable' }` in every HTTP and SDK model and reranker (`openai`, `openai-compatible`, `cohere`, `google`, `jina`, `voyage`, `mistral`, `bedrock`, `ollama`, `tei`, `sparse`), not `InvalidOutput`, so `withResilience` retries an outage. Ollama answering 401 or 403 (a proxy in front of it) is `ConfigurationFailure`.
- Every provider request runs under a 60 s timeout joined with the caller's signal (`requestSignal`). A timeout is `ModelUnavailable { reason: 'unreachable' }`; a caller abort stays `Cancelled`.
- The Transformers model and reranker honour the abort signal before and after a batch. A runtime fault (out of memory, a failed session) is `UnexpectedDefect`, not `InvalidOutput`.
- The Dot `embeddings()` plugin no longer publishes `null` for a configuration that does not build. `boot()` returns the `ConfigurationFailure` (a bad option, a missing key, a refused size) and the plugin logs it at `error`. The published `embedder` is `Embedder`, not `Embedder | null`. An app that can run without embeddings must not mount the plugin.
- `cosine` throws for vectors of different lengths instead of scoring the shorter prefix.
