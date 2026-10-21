---
'@arki/embeddings': minor
---

Add `@arki/embeddings/transformers` and `embedStream`.

- `createTransformersModel()` runs a model in process with Transformers.js (optional peer `@huggingface/transformers`). The default is EmbeddingGemma 300M `q8`, pinned to one Hugging Face commit. The factory is async: it loads the model and embeds one probe text, so `dimensions` is what the weights produce. Concurrent creates share one load, `dispose()` frees the session after the last record lets go, and `countTokens` counts with the loaded tokenizer. Node, Bun and the browser; not Hermes.
- `embedStream(embedder, source, { text, concurrency?, maxPending? })` embeds an iterable or async iterable as a pull-based `ReadableStream` of `{ item, result }` in source order. Memory stays flat, a failed request gives each of its items the failure and the stream goes on, and cancelling aborts the requests in flight.

Review fixes: a throw from the source, `text` or the model inside `embedStream` now aborts in-flight requests, closes the source and drops the `signal` listener; a shared Transformers.js load reports `loadMs` once across records; benches parse JSON and model output with zod; the EmbeddingGemma `q8` size reads "about 316 MB" everywhere.
