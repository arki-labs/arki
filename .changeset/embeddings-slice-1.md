---
'@arki/embeddings': minor
---

`@arki/embeddings`: instructions, long inputs, retries and middleware.

- `EMBEDDINGGEMMA_INSTRUCTION`, `NOMIC_INSTRUCTION` and `E5_INSTRUCTION`. Ollama's `embeddinggemma` and `nomic-embed-text` records now apply their prefixes, so their space id moves from `i0` to `i1`: re-embed an index built with them, or pass `instruction: NO_INSTRUCTION` to keep querying it.
- `onTooLong: 'fail' | 'truncate'`. `'fail'` (default) returns `InputTooLong { index, tokens, max }` before any request, and from a provider's context-length 400 (naming the longest input). `'truncate'` sends Ollama `truncate: true` and cuts OpenAI and OpenAI-compatible inputs at `maxInputTokens * 4` characters. `UnsupportedInput` no longer has the `'truncate'` part. `InputTooLong.index` from `embedMany` now counts within all inputs, not within a chunk.
- `countTokens` is `counted` when a model record carries a tokenizer (the new optional `EmbeddingModel.countTokens`), `estimated` otherwise.
- `normalizeText(text, { romanianDiacritics? })`: NFC, collapsed whitespace, optional ş/ţ → ș/ț. The embedder never calls it.
- `withMiddleware(embedder, ...middleware)` (first outermost) and `withResilience(embedder, policy?)` on `@arki/resilience`: retries only `RateLimited` (at least `retryAfterMs` apart) and `ModelUnavailable { reason: 'unreachable' }`; `usage.requests` counts every attempt.
- Review fixes: `embedMany` with `onTooLong: 'fail'` now refuses an over-long input before any chunk is sent, so no earlier chunk is billed. `'truncate'` on OpenAI and OpenAI-compatible never cuts a character in half (an emoji at the cut is dropped whole). A provider's context-length 400 names the input with the most tokens by `countTokens`, using the record's tokenizer when it has one. The default `withResilience` policy waits out a `retryAfterMs` of up to 5 s; a longer one is not retried and the `RateLimited` comes back at once. A policy you pass gets no `retryAfterMs` minimum.
