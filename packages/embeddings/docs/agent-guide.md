# @arki/embeddings for agents

Read this before changing code that turns text into vectors. The [README](../README.md) is the long overview.

## The model

- A **model record** (`EmbeddingModel`) is the facts about one model (size, batch limits, instruction prefixes) plus one native call, `embedTexts`. `createOllamaModel`, `createOpenAIModel` and `createOpenAICompatibleModel` build them. The provider client lives inside the closure, so the root names no SDK.
- An **embedder** (`createEmbedder(model, options)`) fixes the output options and adds the output check. `embed` and `embedMany` run it.
- **`embedMany`** packs inputs by `maxBatch` and `maxBatchTokens`, runs chunks with bounded concurrency, keeps input order, and is all or nothing.
- A **space** (`EmbeddingSpace`) is what must match for two vectors to be comparable. `spaceId(space)` is its stored string form. A different space means re-embed, never mix.
- **`resolveEmbeddingModel`** picks the model from a ref, `EMBEDDING_MODEL`, or the first configured provider in the order `ollama → openai → voyage → google`. It is pure.
- Every expected failure is a returned `@arki/failure` value. `isEmbedFailure` recognises any of them.
- **`withResilience`** and **`withMiddleware`** wrap an embedder and return an embedder. Retries live only there: adapters never retry.

## Task map

### Embed documents

```ts run
import { createEmbedder, embedMany, resolveEmbeddingModel, spaceId } from '@arki/embeddings';
import { isFailure } from '@arki/failure';

const model = resolveEmbeddingModel('ollama:qwen3-embedding:0.6b', {});
if (isFailure(model)) throw new Error(model.message);
const embedder = createEmbedder(model);
if (isFailure(embedder)) throw new Error(embedder.message);
console.log(spaceId(embedder.space));
```

`embedMany(embedder, texts, { purpose: 'document' })` then gives the vectors. A query uses `purpose: 'query'`: asymmetric models prefix the two differently.

### Keep an index and a model in step

```ts
import type { EmbeddingSpace } from '@arki/embeddings';
import { resolveEmbeddingModel } from '@arki/embeddings';
import { isFailure } from '@arki/failure';

export function modelForIndex(storedSpace: EmbeddingSpace, env: Record<string, string | undefined>) {
  const model = resolveEmbeddingModel(undefined, env, { requiredSpace: storedSpace });
  if (isFailure(model)) return model; // SpaceMismatch when the configured model is another space
  return model;
}
```

### Use a hosted or self-hosted server

- OpenAI: set `OPENAI_API_KEY` (and optionally `EMBEDDING_MODEL=openai:text-embedding-3-small`). Install the peers `ai` and `@ai-sdk/openai`; without them the first call returns `ModelUnavailable` with `reason: 'peer-missing'`.
- Any server with an OpenAI-style `/embeddings` route: `createOpenAICompatibleModel({ id, baseURL, dimensions })` from `@arki/embeddings/openai-compatible`.

### Test code that embeds

```ts run
import { embedMany } from '@arki/embeddings';
import { fakeEmbedder } from '@arki/embeddings/testing';

const embedder = fakeEmbedder({ dimensions: 4 });
const batch = await embedMany(embedder, ['a', 'a', 'b']);
if ('vectors' in batch) console.log(batch.vectors.length);
```

`fakeEmbedder` is deterministic and not semantic. Do not assert ranking by meaning against it.

### Retry rate limits and outages

```ts run
import { embedMany, withResilience } from '@arki/embeddings';
import { fakeEmbedder } from '@arki/embeddings/testing';

const embedder = withResilience(fakeEmbedder({ dimensions: 4 }));
const batch = await embedMany(embedder, ['a', 'b']);
if ('vectors' in batch) console.log(batch.usage.requests);
```

Only `RateLimited` and `ModelUnavailable { reason: 'unreachable' }` are retried. `usage.requests` counts every attempt. The default policy waits at least `retryAfterMs`; over 5 s it does not retry and returns the `RateLimited`. A policy you pass gets no such minimum: its backoff's `delay(attempt, reason)` must read `reason.data.retryAfterMs` itself.

### Cache repeated texts

```ts run
import { embedMany, memoryCacheStore, withCache, withTelemetry } from '@arki/embeddings';
import { fakeEmbedder } from '@arki/embeddings/testing';

const embedder = withTelemetry(withCache(fakeEmbedder({ dimensions: 4 }), memoryCacheStore({ maxEntries: 1000 })));
await embedMany(embedder, ['a', 'b']);
const again = await embedMany(embedder, ['a', 'c']);
if ('vectors' in again) console.log(again.usage.cacheHits); // 1
```

The key covers the space, purpose, size, dtype, truncation choice, namespace and exact text: a model or prompt change misses. Share a cache across processes with `kvCacheStore(kv)` from `@arki/embeddings/kv`. `withTelemetry` emits one `arki.embed` event per call and leaves input texts out unless `recordInputs: true`.

### Give a Dot app its embedder

`embeddings({ model, cache: true })` from `@arki/embeddings/dot` publishes `embedder: Embedder | null`. A configuration that does not resolve logs once at `warn` and publishes `null`: handle `null` in every feature that embeds. Size a vector index from the same space (`vectorIndex({ space })` in `@arki/ai/dot`).

## Rules that bite

- Check every result with `isFailure` before reading `vectors`. A failed `embedMany` has none.
- Store `spaceId(batch.space)` next to every index. Without it you cannot tell a stale index from a fresh one.
- The same text is the same input only byte for byte. The embedder never normalises text; call `normalizeText` yourself, the same way on documents and queries.
- Retry only through `withResilience`. It retries `RateLimited` and an unreachable model, nothing else; never wrap `embed` in a loop of your own.
- An instruction's prefixes are frozen per `version`. Changing one without bumping `version` mixes two spaces under one space id.
- `resolveEmbeddingModel` returns before the network is touched, so Ollama's `revision` is `undefined` until the first call. Read `embedder.space` again after a call.
- Voyage and Google resolve to `ConfigurationFailure` in this release.
- Never catch to hide a thrown error from a custom `embed`. It is a bug in that code.
- `embeddings()` publishes `null` when nothing resolves. A feature that embeds must handle `null`, not assume a model.
- `withTelemetry` never logs input text unless `recordInputs: true`. Keep it that way for user content.

## Errors

### Failures (returned)

| Failure                | Code                           | What to do                                                                                                                      |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `RateLimited`          | `embeddings.rate_limited`      | Wrap the embedder in `withResilience`, or wait `data.retryAfterMs` and retry.                                                   |
| `InputTooLong`         | `embeddings.input_too_long`    | Split the text at `data.index` into smaller chunks, or pass `onTooLong: 'truncate'` if losing its end is acceptable.            |
| `ModelUnavailable`     | `embeddings.model_unavailable` | `not-pulled`: `ollama pull <model>`. `unreachable`: start the server or fix the base URL. `peer-missing`: install the SDK peer. |
| `UnsupportedInput`     | `embeddings.unsupported_input` | Drop the part or option named in `data.part`, or pick a model that supports it.                                                 |
| `InvalidOutput`        | `embeddings.invalid_output`    | Inspect the provider answer in `data.reason`. The batch was discarded.                                                          |
| `SpaceMismatch`        | `embeddings.space_mismatch`    | Re-embed the corpus, or configure the model the index was built with.                                                           |
| `Cancelled`            | `embeddings.cancelled`         | Start a new call with a live `AbortSignal` if the result is still needed.                                                       |
| `ConfigurationFailure` | `embeddings.configuration`     | Fix the provider, model or variable named in `data.message`.                                                                    |

### Errors (thrown)

None are defined. This package throws only what a caller's own `embed` or `onProgress` throws.

## Verify

```sh
turbo run build typecheck lint test --filter=@arki/embeddings
cd packages/embeddings && bun run test:docs
cd packages/embeddings && bun run test:runtimes
bun tooling/library/src/llms.ts --check
```
