---
'@arki/embeddings': minor
---

One dedicated integration per provider (A-42). The package no longer reads environment variables.

- Removed `resolveEmbeddingModel`, the `EmbeddingModelRef` (`provider:model`) type, `EnvSource`, the `EMBEDDING_MODEL` variable and the automatic provider order (`ollama → openai → voyage → google`), and the `./env` entry (`resolveEmbeddingConfig`). Build the model with the provider's own factory from your app's settings: `createOllamaModel({ id, baseURL })`, `createOpenAIModel({ apiKey })`, and so on. No app in the monorepo used the resolver.
- `resolveSpace` stays and moves next to `spaceId`; `isSameSpace(stored, await resolveSpace(embedder))` replaces `resolveEmbeddingModel(…, { requiredSpace })`.
- `embeddings()` from `./dot` now requires `model`: a model record, an `Embedder`, or a function returning one or a failure. The `env` option is gone; read your env inside the function, which runs at boot.
- Each provider adapter parses its own response and recognises its own "input too long" wording. The shared `vectorsByIndex`, `mentionsContextLength` and `providerInputTooLong` helpers are gone; `retryAfterMs` (the standard HTTP header) stays shared.
- `@arki/env` is no longer a dependency.

Upgrade: replace `resolveEmbeddingModel(ref, process.env)` with the provider's `createXModel` call; replace `embeddings({ model: 'ollama:…' })` with `embeddings({ model: () => createOllamaModel({ … }) })`.

no demo impact: no demo builds an embedding model.
