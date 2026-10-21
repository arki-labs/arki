---
'@arki/embeddings': minor
---

Voyage, Cohere, Google and Mistral, and recorded fixtures.

- `@arki/embeddings/voyage`: `createVoyageModel({ id?, apiKey, baseURL?, fetch? })` over plain `fetch`. `voyage-3.5` (default), `voyage-3.5-lite`, `voyage-3-large`, `voyage-code-3`; `input_type` from the purpose; Matryoshka sizes 2048/1024/512/256; native int8 and binary (`ubinary`, MSB first); `truncation` is off unless `onTooLong: 'truncate'`; rows are matched by `index`.
- `@arki/embeddings/cohere`: `createCohereModel(…)` over plain `fetch`. `embed-v4.0` (default), `embed-english-v3.0`, `embed-multilingual-v3.0`; `input_type` is always sent (`search_document` for documents, similarity and no purpose); native int8 and binary; `truncate: 'NONE'` unless asked.
- `@arki/embeddings/google`: `createGoogleModel(…)` through `@ai-sdk/google` (optional peer). `gemini-embedding-001` (default) maps the purpose to `taskType` and re-normalises sizes below 3072; `gemini-embedding-2` uses its documented prefixes (`GEMINI_EMBEDDING_2_INSTRUCTION`, its own version). Google reports no usage, so tokens are `unknown`.
- `@arki/embeddings/mistral`: `createMistralModel(…)` through `@ai-sdk/mistral` (optional peer), `mistral-embed`.
- `resolveEmbeddingModel` builds Voyage and Google in the provider order, and Cohere, Mistral and OpenAI-compatible servers when named (`COHERE_API_KEY`, `MISTRAL_API_KEY`, `OPENAI_COMPATIBLE_{BASE_URL,DIMENSIONS,API_KEY}`). `./env` validates the new variables.
- `@arki/embeddings/testing`: `recordEmbedder(embedder, path)` writes every text call to a JSON file; `fixtureEmbedder(recordings)` replays exactly those calls offline and answers `InvalidOutput` for anything else.
- Model records receive the call's `purpose` in `NativeRequest`, for providers that take it as a field.

Review fixes: replay's `space` is the recording embedder's own space, not the first call's; a recording path that cannot be written is `ConfigurationFailure`, not a throw; replay honours an aborted `signal`; the recorded request schema is locked to `EmbedOptions`; one shared `vectorsByIndex` and one looser "input too long" match serve every fetch adapter; live tests check that Voyage and Cohere binary use our bit order.
