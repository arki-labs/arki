# @arki/embeddings

Text → vectors for ARKI. One `Embedder` shape over every provider, every response checked, every expected failure returned as a value.

```ts
import { isFailure } from '@arki/failure';
import { createEmbedder, embedMany, resolveEmbeddingModel, spaceId } from '@arki/embeddings';

const model = resolveEmbeddingModel(undefined, process.env); // ollama → openai → voyage → google
if (isFailure(model)) throw new Error(model.message);
const embedder = createEmbedder(model);
if (isFailure(embedder)) throw new Error(embedder.message);

const batch = await embedMany(embedder, texts, { purpose: 'document' });
if (isFailure(batch)) return batch; // RateLimited, InputTooLong, ModelUnavailable, …
await index.upsert(batch.vectors, spaceId(batch.space));
```

- **Checked output.** Every response must have one vector per input, the expected dimensions, only finite numbers and a non-zero norm. Anything else is `InvalidOutput`, and the whole batch is discarded.
- **All or nothing.** `embedMany` packs inputs by the model's `maxBatch` and `maxBatchTokens`, runs chunks with bounded concurrency (default 2) and keeps input order. The first failure cancels the remaining chunks and is returned with no vectors.
- **Spaces.** `EmbeddingSpace` says which vectors are comparable: provider, model, revision, dimensions, normalisation, dtype and instruction version. Store `spaceId(space)` next to your index; `isSameSpace` and `resolveEmbeddingModel(…, { requiredSpace })` refuse a different one with `SpaceMismatch`.
- **Failures are values.** `RateLimited`, `InputTooLong`, `ModelUnavailable`, `UnsupportedInput`, `InvalidOutput`, `SpaceMismatch`, `Cancelled`, `ConfigurationFailure` (all `@arki/failure` definitions). `isEmbedFailure` recognises any of them.

## Entries

| Entry | What it is | Peers |
| --- | --- | --- |
| `@arki/embeddings` | types, `createEmbedder`, `embed`, `embedMany`, `resolveEmbeddingModel`, `spaceId`, `isSameSpace`, `cosine`, `countTokens` | none |
| `@arki/embeddings/ollama` | `createOllamaModel({ id?, baseURL?, keepAlive?, dimensions?, fetch? })` over `fetch` `/api/embed` | none |
| `@arki/embeddings/openai` | `createOpenAIModel({ id?, apiKey, baseURL? })` through the AI SDK | `@ai-sdk/openai`, `ai` (optional) |
| `@arki/embeddings/env` | `resolveEmbeddingConfig(env)`: validates the embedding variables with `@arki/env` | none |
| `@arki/embeddings/testing` | `fakeEmbedder({ dimensions, seed?, failures?, delayMs? })` | none |

`resolveEmbeddingModel` is pure: it never touches the network. Ollama's model digest (the space `revision`) is read from `/api/tags` on the first call, so `revision` is `undefined` until then; `isSameSpace` tolerates a missing revision on one side.

`./openai` loads its AI SDK peers on the first call, not at import. A missing peer is the value `ModelUnavailable { reason: 'peer-missing' }` from that first call, not an error at boot.

## Variables

`EMBEDDING_MODEL` (`provider:model`, e.g. `ollama:qwen3-embedding:0.6b`), `OLLAMA_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `VOYAGE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`. Without `EMBEDDING_MODEL`, the first configured provider in the order `ollama → openai → voyage → google` wins. Nothing configured is `ConfigurationFailure`. Voyage and Google records arrive in a later release; until then they resolve to `ConfigurationFailure`.

## Testing

`fakeEmbedder` is seeded and deterministic, and **not semantic**: equal text gives an identical unit vector, different text gives an unrelated one. A test that asserts ranking by meaning passes or fails for the wrong reason with it. A text listed in `failures` fails the whole call with that failure, so all-or-nothing behaviour is visible in tests.

## Benchmarks

<!-- bench:start -->

No published numbers yet. README numbers come only from `bun run bench --profile publish --write-readme` on an idle machine.

<!-- bench:end -->

## License

MIT
