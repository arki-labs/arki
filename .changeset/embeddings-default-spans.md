---
"@arki/embeddings": patch
---

Every model call now runs in a span by default: `embeddings.embed` for each embedder call, `embeddings.sparse_embed` for a sparse embedder and `embeddings.rerank` for each request of a built-in reranker. Spans carry the provider, the model id, the input or document count, the dimensions and `failure.code` on a failure; only a fault (model unavailable, invalid output, configuration) sets the error status. Each call counts in `embeddings.operations` (`operation`, `provider`, `outcome`). Input texts, queries, documents, vectors and keys are never recorded. `withTelemetry` keeps its opt-in `arki.embed` log event; the README no longer calls that event the span. `@opentelemetry/api` is a new dependency.

Docs: README `## Observability` (was `## Telemetry`).
