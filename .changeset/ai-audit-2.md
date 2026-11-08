---
"@arki/ai": minor
---

Breaking: `QdrantVectorProvider` now throws `ConfigurationError` (was `VectorSearchError`) when its `url` is not a URL, because a mistyped `QDRANT_URL` is a configuration fault, not a store outage. Catch `ConfigurationError` at boot instead.

- `OllamaService` checks its own settings when built: a host that is not an http or https URL, or an `AI_DETERMINISTIC_SEED` that is not a whole number, throws `ConfigurationError` (a bad host was a raw `TypeError` from the Ollama library). It reads only `OLLAMA_HOST`, `OLLAMA_BASE_URL` and `AI_DETERMINISTIC_SEED`, so an invalid variable it does not use (say `QDRANT_URL`) no longer stops it.
- `CostEstimator` uses its `fallbackPricing` option: an unknown hosted model is priced at that rate (still basis `default-rate`), in `estimateLLMPrice`, `estimateLLMCost`, `createEstimate`, the embedding estimates and `getModelPricing`. It was accepted and ignored.
- `PIIRedactor`'s default email and street-address patterns run in linear time. 256 KB of `'1 '` blocked the event loop for about 33 s; it now scans in milliseconds. They find the same emails and addresses; a street name may have at most 8 words before its suffix.
