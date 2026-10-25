# @arki/embeddings

Text → vectors and rerank. For vector, semantic and hybrid search see `@arki/search`.

One `Embedder` shape over every provider, every response checked, every expected failure returned as a value.

## Install

```sh
bun add @arki/embeddings @arki/failure
```

`@arki/failure` gives you `isFailure`. The `./openai` entry also needs the optional peers `ai` and `@ai-sdk/openai`; `./transformers` needs the optional peer `@huggingface/transformers`. The root, `./ollama`, `./openai-compatible`, `./rerank`, `./tei` and `./testing` need no peer at run time. `fromArkiEmbedder` in `./testing` returns a type from the optional peer `@arki/testing`; install it when you use that function.

## Quick start

Build the model with its provider's factory, from your app's own settings, then embed. The imports come from `@arki/embeddings`, `@arki/embeddings/ollama` and `@arki/failure`.

```ts from="examples/index-documents.ts#embed-documents"
/** Builds the model from the app's own settings, then embeds every text. The first failure comes back as the value. */
export async function embedDocuments(texts: readonly string[], ollamaBaseURL: string) {
  const model = createOllamaModel({ id: 'qwen3-embedding:0.6b', baseURL: ollamaBaseURL });
  if (isFailure(model)) return model;
  const embedder = createEmbedder(model);
  if (isFailure(embedder)) return embedder;
  return embedMany(embedder, texts, { purpose: 'document' });
}
```

The package never reads environment variables: your app reads its own (with `@arki/env` or any schema) and passes keys and URLs to `createXModel`, so which provider runs is a line of your code, not a variable. Store `spaceId(batch.space)` next to your index, so you can tell later which model made the vectors.

- **Checked output.** Every response must have one vector per input, the expected dimensions, only finite numbers and a non-zero norm. Anything else is `InvalidOutput`, and the whole batch is discarded.
- **All or nothing.** `embedMany` packs inputs by the model's `maxBatch` and `maxBatchTokens`, runs chunks with bounded concurrency (default 2) and keeps input order. The first failure cancels the remaining chunks and is returned with no vectors.
- **Spaces.** `EmbeddingSpace` says which vectors are comparable: provider, model, revision, dimensions, normalisation, dtype and instruction version. Store `spaceId(space)` next to your index; `isSameSpace(stored, await resolveSpace(embedder))` tells a different one apart before anything is embedded; answer `SpaceMismatch` then, never a silent re-embed.

To add vectors to an existing index, refuse a different space before any request is sent:

```ts from="examples/index-documents.ts#embed-for-index"
/** Refuses to add vectors to an index that was built in another space. Nothing is sent to the provider then. */
export async function embedForIndex(embedder: Embedder, texts: readonly string[], indexSpace: EmbeddingSpace) {
  if (!isSameSpace(embedder.space, indexSpace)) return SpaceMismatch({ expected: indexSpace, actual: embedder.space });
  return embedMany(embedder, texts, { purpose: 'document' });
}
```

## When not to use this

- Vector storage and search. This package makes vectors and compares nothing for you; `cosine` is for tests and rescoring.
- Multi-vector output (one vector per token). No adapter produces it.
- Meaning-based assertions in tests with `fakeEmbedder`. Its vectors are not semantic (see [Testing](#testing)).

## Runtime support

`yes` means the smoke script (`bun run test:runtimes`) runs that entry on that engine. `–` means the smoke does not run it, so nothing is claimed.

| Entry                                | Node   | Bun    | Deno | Browser | Hermes |
| ------------------------------------ | ------ | ------ | ---- | ------- | ------ |
| `@arki/embeddings`                   | yes    | yes    | yes  | yes     | yes    |
| `@arki/embeddings/ollama`            | yes    | yes    | yes  | yes     | yes    |
| `@arki/embeddings/openai-compatible` | yes    | yes    | yes  | yes     | yes    |
| `@arki/embeddings/kv`                | yes    | yes    | yes  | yes     | yes    |
| `@arki/embeddings/testing`           | yes    | yes    | yes  | yes     | yes    |
| `@arki/embeddings/openai`            | –      | –      | –    | –       | –      |
| `@arki/embeddings/voyage`            | –      | –      | –    | –       | –      |
| `@arki/embeddings/cohere`            | –      | –      | –    | –       | –      |
| `@arki/embeddings/google`            | –      | –      | –    | –       | –      |
| `@arki/embeddings/mistral`           | –      | –      | –    | –       | –      |
| `@arki/embeddings/jina`              | –      | –      | –    | –       | –      |
| `@arki/embeddings/bedrock`           | –      | –      | –    | –       | –      |
| `@arki/embeddings/sparse`            | –      | –      | –    | –       | –      |
| `@arki/embeddings/rerank`            | –      | –      | –    | –       | –      |
| `@arki/embeddings/tei`               | –      | –      | –    | –       | –      |
| `@arki/embeddings/dot`               | –      | –      | –    | –       | –      |
| `@arki/embeddings/transformers`      | opt-in | opt-in | –    | opt-in  | –      |

- `package.json` declares Node, Bun, Deno, browser and Hermes for the package as a whole. It has no per-entry list.
- The smoke also checks that every built entry imports in Node with an empty environment. An adapter entry whose optional peer is not installed is reported as incomplete, not as a failure.
- `./transformers` in a browser downloads the model (about 300 MB), so that leg is opt-in. Set `TRANSFORMERS_SMOKE=1` to run it.
- The Hermes leg runs only where `HERMES_BIN` is set.
- The root imports no provider SDK, no `process.env` and no `node:*`. `./openai`, `./google`, `./mistral` and `./bedrock` load their AI SDK peers on the first call, not at import.

Debug logs use the `arki:embeddings` category. Show them with `DEBUG=arki:embeddings`.

## Public imports

| Entry                                | What it is                                                                                                                                                                                                                                                                                                                                                                | Peers                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `@arki/embeddings`                   | types, `createEmbedder`, `embed`, `embedMany`, `embedStream`, `withResilience`, `withCache`, `memoryCacheStore`, `withTelemetry`, `withMiddleware`, `resolveSpace`, `spaceId`, `isSameSpace`, `cosine`, `l2Normalize`, `norm`, `truncate`, `quantize`, `calibrateInt8`, `unpackBits`, `hamming`, `countTokens`, `normalizeText`, the `*_INSTRUCTION` tables, the failures | none                                      |
| `@arki/embeddings/ollama`            | `createOllamaModel({ id?, baseURL?, keepAlive?, dimensions?, fetch? })` over `fetch` `/api/embed`                                                                                                                                                                                                                                                                         | none                                      |
| `@arki/embeddings/openai`            | `createOpenAIModel({ id?, apiKey, baseURL? })` through the AI SDK                                                                                                                                                                                                                                                                                                         | `@ai-sdk/openai`, `ai` (optional)         |
| `@arki/embeddings/openai-compatible` | `createOpenAICompatibleModel({ id, baseURL, dimensions, apiKey?, … })` for any server that speaks `/embeddings`                                                                                                                                                                                                                                                           | none                                      |
| `@arki/embeddings/voyage`            | `createVoyageModel({ id?, apiKey, baseURL?, fetch? })` over `fetch`: `voyage-3.5` by default, `input_type` from the purpose, native int8 and binary; `createVoyageReranker({ id?, apiKey })`: `rerank-2.5` by default                                                                                                                                                     | none                                      |
| `@arki/embeddings/cohere`            | `createCohereModel({ id?, apiKey, baseURL?, fetch? })` over `fetch`: `embed-v4.0` by default, `input_type` from the purpose (always sent), native int8 and binary; `createCohereReranker({ id?, apiKey })` (`rerank-v3.5`) and `createCohereCompatibleReranker({ baseURL, id })` for Infinity, vLLM and llama.cpp                                                         | none                                      |
| `@arki/embeddings/google`            | `createGoogleModel({ id?, apiKey, baseURL?, fetch? })` through the AI SDK: `gemini-embedding-001` (`taskType` from the purpose) or `gemini-embedding-2` (prefixes)                                                                                                                                                                                                        | `@ai-sdk/google`, `ai` (optional)         |
| `@arki/embeddings/mistral`           | `createMistralModel({ id?, apiKey, baseURL?, fetch? })` through the AI SDK: `mistral-embed`                                                                                                                                                                                                                                                                               | `@ai-sdk/mistral`, `ai` (optional)        |
| `@arki/embeddings/jina`              | `createJinaModel({ id?, apiKey, baseURL?, fetch? })` over `fetch`: `jina-embeddings-v3` (1024 dims, sizes 1–1024), `task` from the purpose; `createJinaReranker({ id?, apiKey })`: `jina-reranker-v2-base-multilingual` by default                                                                                                                                        | none                                      |
| `@arki/embeddings/bedrock`           | `createBedrockModel({ id?, region?, apiKey?, accessKeyId?, secretAccessKey?, sessionToken? })` through the AI SDK: Titan Text Embeddings V2 (1024/512/256). Node and Bun only                                                                                                                                                                                             | `@ai-sdk/amazon-bedrock`, `ai` (optional) |
| `@arki/embeddings/sparse`            | `createSparseModel({ id, baseURL, dimensions, … })`: SPLADE sparse vectors from TEI's `/embed_sparse`; `requireSparseSpace`                                                                                                                                                                                                                                               | none                                      |
| `@arki/embeddings/rerank`            | `rerank(reranker, query, items, { text, topK?, onTooLong?, signal? })`, `withRerankCache(reranker, store)`, the `Reranker` type                                                                                                                                                                                                                                           | none                                      |
| `@arki/embeddings/tei`               | `createTeiReranker({ id, baseURL, maxDocuments?, maxInputTokens? })`: a reranker on a TEI server's `/rerank`                                                                                                                                                                                                                                                              | none                                      |
| `@arki/embeddings/kv`                | `kvCacheStore(kv, { prefix? })`: a `CacheStore` over an `@arki/kv` client (anything with its `get` and `set`)                                                                                                                                                                                                                                                             | none                                      |
| `@arki/embeddings/dot`               | `embeddings({ model, cache?, resilience? })`: the app's embedder as a Dot plugin                                                                                                                                                                                                                                                                                          | `@arki/dot` (optional)                    |
| `@arki/embeddings/transformers`      | `await createTransformersModel({ id?, revision?, dtype?, device?, cacheDir?, onProgress?, instruction? })`: a model run in process, EmbeddingGemma `q8` by default; `await createTransformersReranker({ id?, dtype?, … })`: bge-reranker-v2-m3 `q8` or Qwen3-Reranker-0.6B in process                                                                                     | `@huggingface/transformers` (optional)    |
| `@arki/embeddings/testing`           | `fakeEmbedder({ dimensions, seed?, failures?, delayMs? })`; `recordEmbedder(embedder, path)` and `fixtureEmbedder(recordings)` to replay a real model offline; `fakeReranker({ scores?, maxDocuments?, maxInputTokens? })`; `fromArkiEmbedder(embedder)`: any embedder as the `@arki/testing/ai` judge embedder                                                           | `@arki/testing` (optional, types only)    |

Creating a model never touches the network. Ollama's model digest (the space `revision`) is read from `/api/tags` on the first call, so `revision` is `undefined` until then; `isSameSpace` tolerates a missing revision on one side. To compare with stored space ids before anything is embedded (a job that looks for stale rows), `await resolveSpace(embedder)` reads the digest without embedding and answers the full space, or `ModelUnavailable` (`unreachable` or `not-pulled`).

## Options schemas

Every public options object has a Standard Schema. The root exports `embedOptionsSchema`, `embedManyOptionsSchema`, `embedStreamOptionsSchema`, `embedderOptionsSchema` and `normalizeTextOptionsSchema`. Each provider entry exports its own, such as `cohereRerankerOptionsSchema` from `./cohere`. Factories such as `createCohereReranker` return a `ConfigurationFailure` when the options are bad. Per-call options such as `embed`'s throw through `assert`, because a bad call option is a bug in the caller.

To read a schema as JSON Schema:

```ts
import { embedOptionsSchema } from '@arki/embeddings';

const jsonSchema = embedOptionsSchema['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
```

## Failure behaviour

Every expected failure is returned, never thrown. Each is an `@arki/failure` definition: check it with `isFailure`, a definition's `is`, or `isEmbedFailure` for any of them.

| Failure                | Code                           | Status | When                                                                                         |
| ---------------------- | ------------------------------ | ------ | -------------------------------------------------------------------------------------------- |
| `RateLimited`          | `embeddings.rate_limited`      | 429    | The provider throttles this caller. `data.retryAfterMs` when it said how long.               |
| `InputTooLong`         | `embeddings.input_too_long`    | 400    | One input is longer than the model or one request accepts. `data`: `index`, `tokens`, `max`. |
| `ModelUnavailable`     | `embeddings.model_unavailable` | 503    | `not-pulled`, `unreachable`, `peer-missing` or `unknown-model`. `data`: `model`, `reason`.   |
| `UnsupportedInput`     | `embeddings.unsupported_input` | 400    | An input part or option the model cannot do. `data`: `index` (-1 for an option), `part`.     |
| `InvalidOutput`        | `embeddings.invalid_output`    | 502    | The answer failed the output check. The whole batch is discarded. `data`: `reason`.          |
| `SpaceMismatch`        | `embeddings.space_mismatch`    | 409    | The model is not the space the index was built in. `data`: `expected`, `actual`.             |
| `Cancelled`            | `embeddings.cancelled`         | 499    | The `AbortSignal` fired.                                                                     |
| `ConfigurationFailure` | `embeddings.configuration`     | 500    | No provider configured, a bad variable, or a provider with no record yet. `data`: `message`. |

A throw from a custom `embed` or an `onProgress` callback is a bug in that code, not a failure value. `embedMany` stops the other chunks and rethrows it.

## Retries

`withResilience(embedder, policy?)` returns an embedder whose every call runs through an `@arki/resilience` policy. `embedMany` over it retries each chunk on its own.

- It retries only `RateLimited` and `ModelUnavailable { reason: 'unreachable' }`.
- With the default policy, a `RateLimited` with `retryAfterMs` waits at least that long. Over 5 s, it is not retried: the `RateLimited` comes back at once and you decide when to try again.
- A policy you pass gets no `retryAfterMs` minimum. To honour it, have its backoff's `delay(attempt, reason)` return at least `reason.data.retryAfterMs` when `RateLimited.is(reason)`.
- Every other failure comes back after one attempt. Retrying bad input or a bad key burns quota and hides the bug.
- `usage.requests` counts every attempt, failed ones included.
- A timeout, an open circuit or a full bulkhead becomes `ModelUnavailable { reason: 'unreachable' }`. Nothing is thrown for them.
- The default policy: 3 retries from 200 ms doubling to 5 s with 25% jitter, a circuit breaker (5 failures, 30 s), and 60 s per attempt. Pass your own policy built with `.while(RateLimited, ModelUnavailable)` on its backoff to change that.

## Caching

`withCache(embedder, store?, { strict?, namespace?, ttlMs? })` returns an embedder that answers repeated texts from a byte store.

- The key is a sha256 of the value format version, the space id, the purpose, the size, the dtype, the truncation choice, the namespace and the exact text. A model, size or prompt change misses; it never answers a wrong vector in the right shape.
- Cached inputs are filled from the store. The rest go to the provider as one call, in input order. `usage.cacheHits` counts the inputs the store answered; an all-hit call sends nothing and has `requests: 0`.
- `strict: true` (default): a cached value whose length or dtype does not fit the space is `InvalidOutput`. `strict: false`: it counts as a miss and is embedded again. A strict failure lasts as long as the bad entry: until its TTL ends, or forever without one. Set `ttlMs` on a store other writers share.
- Image inputs always go to the provider. A failure is never cached.
- A store that throws is a miss (read) or skipped (write), logged at `warn`. Embedding still works.
- Ollama learns its model digest on the first call, and the digest is part of the key, so the first call of a process always misses.

`memoryCacheStore({ maxEntries? })` is an in-process LRU (default 10 000 entries) that copies on `set` and on `get`. `kvCacheStore(kv, { prefix? })` from `@arki/embeddings/kv` stores the bytes as base64 through an `@arki/kv` client, so processes share one cache; `ttlMs` becomes whole seconds, and a value that is not base64 reads as a miss.

## Telemetry

`withTelemetry(embedder, { log?, recordInputs? })` emits one `arki.embed` event per `embed` call, at `info`: `provider`, `model`, `dimensions`, `inputs` (the count), `tokenBasis`, `tokens`, `requests`, `cacheHits`, `durationMs` and `outcome` (`'ok'` or the failure's code). `@arki/log` has no span type, so the event is the span; `@arki/log/otel` adds the active trace. Input texts are left out unless `recordInputs: true`, because inputs carry emails, names and tokens. Wrap it outside `withCache` to see hits, inside to see only provider calls.

## Dot plugin

`embeddings({ model, cache?, resilience? })` from `@arki/embeddings/dot` publishes `embedder` (`Embedder | null`), built once at boot. `model` is a model record, an `Embedder`, or a function returning one of them or a failure; the function runs at boot, so read your env there. `cache: true` adds `withCache` over a `memoryCacheStore()`, or pass a store; `resilience: true` adds `withResilience`, or pass a policy. The cache sits outside the retries. A model that does not build (a missing key returned as `ConfigurationFailure`) is logged once at `warn` and `embedder` is `null`, so the app boots and features degrade.

`withMiddleware(embedder, ...middleware)` wraps `embed` with your own `EmbedMiddleware` functions. The first one is outermost: it sees the call first and the result last.

## Streaming a corpus

`embedStream(embedder, source, { text, concurrency?, maxPending?, ...options })` embeds an iterable or async iterable of any length and returns a `ReadableStream` of `{ item, result }` in source order. It reads the source only while you read the stream, with at most `maxPending` items (default 64) read and not yet delivered, so memory stays flat. A failed request does not end the stream: each of its items gets the failure as its `result`. The first item of each request carries that request's `usage` and the others carry zero, so the sum over all items is the total. Cancelling the stream, or aborting `signal`, aborts the requests in flight and reads no more.

```ts run expect
import { embedStream, isEmbedFailure, RateLimited } from '@arki/embeddings';
import { fakeEmbedder } from '@arki/embeddings/testing';

const documents = [
  { id: 'a', body: 'first' },
  { id: 'b', body: 'second' },
  { id: 'c', body: 'refused' },
];
const embedder = fakeEmbedder({ dimensions: 8, failures: { refused: RateLimited({}) } });

for await (const { item, result } of embedStream(embedder, documents, { text: doc => doc.body })) {
  console.log(item.id, isEmbedFailure(result) ? result.code : result.vector.length);
}
```

```text
a embeddings.rate_limited
b embeddings.rate_limited
c embeddings.rate_limited
```

Here all three documents share one request, so the one refused text fails all three. With a real model, `maxBatch` decides how many share a request.

## In-process models

`createTransformersModel` from `@arki/embeddings/transformers` runs a model with Transformers.js, no server. The default is [EmbeddingGemma 300M](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX), `q8` weights (about 316 MB, downloaded on the first load), pinned to one Hugging Face commit, so its space is `immutable`. EmbeddingGemma is released under the [Gemma Terms of Use](https://ai.google.dev/gemma/terms), not an open-source licence: read them before you ship it.

`id: 'onnx-community/embeddinggemma-2-ONNX'` loads [EmbeddingGemma 2](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX) instead: Apache-2.0, 8,192 tokens, sizes 768/512/256/128, also pinned. Transformers.js loads its vision and audio encoders with it, about 850 MB in `q8` against 316 MB. It is not the default yet; see [Quality](#quality).

```ts
import { createEmbedder, embedMany, isEmbedFailure } from '@arki/embeddings';
import { createTransformersModel } from '@arki/embeddings/transformers';

export async function embedLocally(texts: readonly string[]) {
  const model = await createTransformersModel({ cacheDir: '.cache/models' });
  if (isEmbedFailure(model)) return model; // ModelUnavailable: peer-missing, unknown-model or unreachable
  const embedder = createEmbedder(model);
  if (isEmbedFailure(embedder)) return embedder;
  const batch = await embedMany(embedder, texts, { purpose: 'document' });
  await model.dispose?.();
  return batch;
}
```

- **Observed size.** The factory loads the model and embeds one probe text; `dimensions` is the size the weights produced (768 for EmbeddingGemma).
- **One load per model.** Concurrent calls with the same id, revision, dtype, device and cache dir share one load. The session is freed when every record from it has called `dispose()`.
- **Exact counts.** `countTokens` uses the loaded tokenizer, so counts are `counted` and the length check is exact.
- Another id works if its ONNX export has a `sentence_embedding` output, or a `last_hidden_state` that is then mean-pooled. Pass `revision` as a commit to keep its space `immutable`, and `instruction` for its prefixes.

## Long inputs

`onTooLong` decides what happens to an input longer than the model's `maxInputTokens`:

- `'fail'` (the default) returns `InputTooLong` with the input's `index`, its token count and the limit, before any request is sent. When the provider's own count disagrees and it answers 400, that is `InputTooLong` too, naming the longest input.
- `'truncate'` sends it anyway. Ollama cuts it itself. OpenAI and OpenAI-compatible servers have no such flag, so the text is cut at `maxInputTokens * 4` characters first (never inside a character). That cut is a character estimate: dense text (CJK, code) has more tokens per character, so it can still be over the limit and come back as `InputTooLong`.

Counts are `estimated` (`ceil(characters / 4)`) unless the model record carries a tokenizer, in which case they are `counted`.

## Instructions

Asymmetric models were trained with a prefix per purpose. The model record applies it for the `purpose` you pass; `instruction.version` is part of the space id, so a changed prefix is a new space.

| Table                          | Models                                   | `query`                          | `document`              |
| ------------------------------ | ---------------------------------------- | -------------------------------- | ----------------------- |
| `QWEN3_INSTRUCTION`            | Qwen3-Embedding (Ollama default)         | `Instruct: … Query: `            | none                    |
| `EMBEDDINGGEMMA_INSTRUCTION`   | `embeddinggemma`                         | `task: search result \| query: ` | `title: none \| text: ` |
| `EMBEDDINGGEMMA_2_INSTRUCTION` | EmbeddingGemma 2 (`./transformers`)      | `task: search result \| query: ` | `title: none \| text: ` |
| `NOMIC_INSTRUCTION`            | `nomic-embed-text`                       | `search_query: `                 | `search_document: `     |
| `E5_INSTRUCTION`               | E5 family, through `./openai-compatible` | `query: `                        | `passage: `             |
| `NO_INSTRUCTION`               | OpenAI, the fake                         | none                             | none                    |

EmbeddingGemma and nomic also have `classification` and `clustering` prefixes; EmbeddingGemma has `similarity`.

## Smaller vectors

Three ways to shrink a vector, from most to least faithful:

- **Matryoshka sizes.** `createEmbedder(model, { dimensions: 256 })` asks for a size from `model.matryoshka`. `truncate(vector, 256, model)` does the same to a vector you already have: it keeps the first 256 values and re-normalises them when the model's vectors are unit length. Any other size is `UnsupportedInput`.
- **Int8**, one byte per dimension. Each value is mapped from a per-dimension `[min, max]` onto -128…127. The range comes from `calibrateInt8(sample)` over a sample of _your corpus_, and the whole corpus must share it: vectors scaled differently are not comparable. With `createEmbedder(model, { quantization: 'int8', calibration })` the space id names the calibration (`…/i8@<16 hex>/…`), so an index made with another range is a different space. Without a calibration, int8 works only when the provider makes it natively.
- **Binary**, one bit per dimension, set when the value is above 0. `quantize(vector, 'binary')` and `createEmbedder(model, { quantization: 'binary' })` pack eight dimensions per byte, **most significant bit first**: dimension 0 is bit 7 of byte 0, as in sentence-transformers, Transformers.js, Qdrant and pgvector `bit`. The size must be a multiple of 8. `hamming(a, b)` counts differing bits for a cheap first pass; rescore the best candidates with float vectors. `unpackBits(bits, dimensions)` turns bits back into ±1 floats.

A dtype the provider makes natively is asked of the provider; otherwise the embedder validates the floats first and quantizes them itself.

```ts run expect
import { calibrateInt8, hamming, quantize, unpackBits } from '@arki/embeddings';
import { isFailure } from '@arki/failure';

const a = Float32Array.of(0.3, -0.1, 0, 0.2, -0.5, -0.4, 0.9, 0.1);
const b = Float32Array.of(0.2, 0.4, -0.3, 0.2, -0.5, -0.4, 0.9, -0.1);

const bitsA = quantize(a, 'binary');
const bitsB = quantize(b, 'binary');
if (isFailure(bitsA) || isFailure(bitsB)) throw new Error('8 dimensions always pack');
console.log('a packed:', (bitsA[0] ?? 0).toString(2).padStart(8, '0'));
console.log('bits that differ:', hamming(bitsA, bitsB));
console.log('unpacked:', Array.from(unpackBits(bitsA, 8)).join(' '));

const int8 = quantize(a, 'int8', calibrateInt8([a, b]));
console.log('a as int8:', isFailure(int8) ? int8.code : Array.from(int8).join(' '));
```

```text
a packed: 10010011
bits that differ: 2
unpacked: 1 -1 -1 1 -1 -1 1 1
a as int8: 127 -128 127 0 0 0 0 127
```

## Images

An input can be `{ image, mimeType?, text? }`. PNG, JPEG, GIF and WebP are recognised from their bytes when `mimeType` is left out. A model that cannot take images refuses with `UnsupportedInput { part: 'image' }` before any request, so an image is never dropped while the rest is embedded. Prefixes apply to the text part only, and image inputs are never cached.

| Models that take images                                      | How                                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `google:gemini-embedding-2`                                  | Gemini REST `batchEmbedContents`, one request per input; `gemini-embedding-001` is text only              |
| `cohere:embed-v4.0`                                          | Cohere v2 `inputs` with text and image parts; the v3 models are text only                                 |
| `voyage:voyage-multimodal-3.5`, `voyage:voyage-multimodal-3` | `/v1/multimodalembeddings`, 1024 dims, no smaller sizes and no int8/binary; the text models are text only |

## Sparse vectors

`@arki/embeddings/sparse` makes SPLADE vectors (`{ indices: Uint32Array; values: Float32Array }`, indices ascending) from a [TEI](https://github.com/huggingface/text-embeddings-inference) server started with `--pooling splade`, for example with the Apache-2.0 `opensearch-project/opensearch-neural-sparse-encoding-multilingual-v1`. Each index is a token of the model's vocabulary, so the space carries a `vocabulary`; `requireSparseSpace` answers `SpaceMismatch` when two vocabularies differ. BGE-M3's sparse output needs TEI pull request [#899](https://github.com/huggingface/text-embeddings-inference/pull/899) first. `@arki/ai`'s Qdrant provider stores a sparse vector next to the dense one.

## Reranking

A reranker reads the query and each document together and scores how well the document answers it. It is slower than comparing vectors and much better at the top of a list, so the usual shape is: search for 50 candidates, rerank them, keep 10. `rerank()` is in `@arki/embeddings/rerank`; each reranker lives in its provider's entry.

```ts
import { rerank } from '@arki/embeddings/rerank';
import { createTransformersReranker } from '@arki/embeddings/transformers';
import { isFailure } from '@arki/failure';

const hits = [
  { id: 'a', text: 'Margherita: tomato, mozzarella, basil.' },
  { id: 'b', text: 'Diavola: tomato, mozzarella, spicy salami.' },
  { id: 'c', text: "The scooter to Ada's house is running late." },
];

export async function best() {
  const reranker = await createTransformersReranker();
  if (isFailure(reranker)) return reranker;
  const ranked = await rerank(reranker, 'Which pizza has no meat?', hits, { text: hit => hit.text, topK: 1 });
  await reranker.dispose?.();
  return ranked; // { hits: [{ item: { id: 'a', … }, index: 0, score }], usage } or a failure value
}
```

- `rerank()` splits the items over the reranker's `maxDocuments` and merges the scores, then keeps `topK`. A per-request cut would keep each request's local winners, not the best overall.
- Each hit carries your item, its index in `items` and its score. Equal scores keep input order.
- Scores are per pair, so scores from two requests compare. Their range is the model's: Cohere, Voyage, Jina, TEI and the local rerankers answer 0–1.

### Long documents: the chunk policy

A document that does not fit beside the query (`maxInputTokens` counts query plus one document) follows `onTooLong`:

| `onTooLong`        | What happens                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `'fail'` (default) | `InputTooLong` naming the item, before any request. Nothing is lost without you knowing.                                                                                       |
| `'truncate'`       | The whole document is sent and the provider cuts its end off.                                                                                                                  |
| `'split'`          | The document is scored as overlapping windows that each fit (a quarter overlaps), and the item gets its best window's score: a long answer is as relevant as its best passage. |

Tokens are counted with the reranker's tokenizer when it has one (`./transformers`), else estimated at 4 characters per token. The estimate undercounts Romanian (near 3 characters per token) and CJK text (near 1). Cohere and Jina cut or chunk long documents on their side and have no switch to refuse them, so for those the estimate is the only check under `'fail'`. Without a tokenizer, `'split'` sizes its windows at 2 characters per token, so most text fits; a denser script that still overflows is refused (`InputTooLong`), never cut.

### Rerankers

| Reranker                                                                        | Entry            | Reads (tokens, query + document) |             Per request |
| ------------------------------------------------------------------------------- | ---------------- | -------------------------------: | ----------------------: |
| `createTransformersReranker()` bge-reranker-v2-m3                               | `./transformers` |                  1024 by default |                      16 |
| `createTransformersReranker({ id: 'onnx-community/Qwen3-Reranker-0.6B-ONNX' })` | `./transformers` |                  1024 by default | 16 (one model run each) |
| `createCohereReranker()` `rerank-v3.5`; v4 and v5 read 32 000                   | `./cohere`       |                             4096 |                    1000 |
| `createCohereCompatibleReranker({ baseURL, id })`                               | `./cohere`       |               you state it (512) |     you state it (1000) |
| `createVoyageReranker()` `rerank-2.5`, `-lite`, `rerank-2`, `-2-lite`           | `./voyage`       |                           32 000 |                    1000 |
| `createJinaReranker()` v2 multilingual; `jina-reranker-v3`, `-m0`               | `./jina`         |                             1024 |                    1000 |
| `createTeiReranker({ id, baseURL })`                                            | `./tei`          |               you state it (512) |       you state it (32) |

The local rerankers download their weights on first use: 570 MB for bge-reranker-v2-m3 `q8`, 1.2 GB for Qwen3-Reranker-0.6B `q8`. With `q8` weights a score moves by up to 0.002 with the other documents in its batch; `fp16` holds it to 3e-6.

`withRerankCache(reranker, store)` keeps one score per provider, model, revision, truncation, query and document in any `CacheStore` (`memoryCacheStore()`, `kvCacheStore(kv)`); a repeat costs no request.

## Limits

- **A request is one provider call of at most `maxBatch` inputs and `maxBatchTokens` tokens.** `embedMany` splits larger work for you. One input that alone costs more than `maxBatchTokens` is refused with `InputTooLong` before any request is sent.
- **Token counts are estimates** (`ceil(characters / 4)`) except for `./transformers`, which counts with the loaded tokenizer. A provider's own count replaces an estimate in the result when the provider reports one.
- **One input** may cost at most the model's `maxInputTokens`; see [Long inputs](#long-inputs).
- **Dimensions** must be the model's native size or one of its Matryoshka sizes. Any other size is `UnsupportedInput`, not a silent resize.
- **Texts are never changed.** The embedder sends exactly what you pass, so the same text in a different Unicode form is a different input. Call `normalizeText(text, { romanianDiacritics? })` yourself, on documents and queries alike: NFC, one space per whitespace run, and optionally ş/ţ → ș/ț.
- **A failed batch has no partial result.** If chunk 7 of 10 fails, you get the failure and none of the vectors. Use `embedStream` when each item should get its own result.

The boundary, with the fake embedder: its limit is 1 000 000 tokens per request, which is 4 000 000 characters.

```ts run expect
import { embedMany, InputTooLong } from '@arki/embeddings';
import { fakeEmbedder } from '@arki/embeddings/testing';
import { isFailure } from '@arki/failure';

const embedder = fakeEmbedder({ dimensions: 8 });

const atLimit = await embedMany(embedder, ['a'.repeat(4_000_000)]);
console.log('4 000 000 characters:', isFailure(atLimit) ? atLimit.code : 'embedded');

const overLimit = await embedMany(embedder, ['a'.repeat(4_000_001)]);
console.log('4 000 001 characters:', InputTooLong.is(overLimit) ? overLimit.code : 'embedded');
```

```text
4 000 000 characters: embedded
4 000 001 characters: embeddings.input_too_long
```

## Testing

`fakeEmbedder` is seeded and deterministic, and **not semantic**: equal text gives an identical unit vector, different text gives an unrelated one. A test that asserts ranking by meaning passes or fails for the wrong reason with it. A text listed in `failures` fails the whole call with that failure, so all-or-nothing behaviour is visible in tests.

To test ranking with real vectors but no network, record a real model once and replay it. `recordEmbedder(embedder, path)` writes every text call to one JSON file (Node, Bun and Deno); commit the file. `fixtureEmbedder(JSON.parse(text))` answers exactly the recorded calls, with the recorded space and the same chunking. A call that was not recorded is `InvalidOutput { reason: 'no fixture …' }`, and a file that does not parse is `ConfigurationFailure`.

```ts
import { readFileSync } from 'node:fs';

import type { Embedder } from '@arki/embeddings';
import { embedMany } from '@arki/embeddings';
import { fixtureEmbedder, recordEmbedder } from '@arki/embeddings/testing';

// Once, against the real model; commit the file it writes.
export async function record(real: Embedder, corpus: readonly string[]) {
  return embedMany(recordEmbedder(real, '__fixtures__/qwen3.json'), corpus, { purpose: 'document' });
}

// In every test run after that: the same calls answer the same vectors, offline.
export const replay = fixtureEmbedder(JSON.parse(readFileSync('__fixtures__/qwen3.json', 'utf8')));
```

`fromArkiEmbedder(embedder)` turns any embedder into the embedder that `similarTo` and the judge of `@arki/testing/ai` take. Texts go in as `purpose: 'document'`. A failure becomes a thrown `Error` with the failure's message, because a judge cannot go on without vectors.

```ts
import { fakeEmbedder, fromArkiEmbedder } from '@arki/embeddings/testing';

// Pass it as `embedder` to `similarTo` or `toScore` from `@arki/testing/ai`.
export const judgeEmbedder = fromArkiEmbedder(fakeEmbedder({ dimensions: 16 }));
```

`fakeReranker({ scores })` is the reranker counterpart: a document listed in `scores` gets that score, any other a seeded one, and like a real reranker it refuses more than `maxDocuments` documents or a pair over `maxInputTokens`.

## Quality

`bun run eval` (`bench/quality.eval.ts`) scores retrieval on [SciFact and NFCorpus](https://github.com/beir-cellar/beir) (BEIR, whole corpora, test qrels) and Romanian similarity on [RO-STS](https://github.com/dumitrescustefan/RO-STS). Every file is pinned by commit and sha256. `--dataset <dir>` adds any folder in the BEIR shape; `--models a,b` picks rows; `--self-check` compares Qwen3 0.6B through the library with a bare `/api/embed` call; `--pool <dir>` writes each `--dataset` set's grading pool (the top 20 of BM25 and of every model, in id order) for annotators. Hosted rows run when `OPENAI_API_KEY`, `VOYAGE_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` is set.

Run on 2026-10-22, Apple Silicon. Quality numbers do not depend on machine load: the same weights give the same vectors.

| Model                                          | SciFact nDCG@10 | SciFact R@50 | NFCorpus nDCG@10 | NFCorpus R@50 | RO-STS ρ |
| ---------------------------------------------- | --------------: | -----------: | ---------------: | ------------: | -------: |
| BM25 (no stemming)                             |           0.662 |        0.870 |            0.307 |         0.212 |        – |
| `qwen3-embedding:0.6b`, Ollama (local default) |           0.700 |        0.933 |            0.361 |         0.283 |    0.736 |
| `qwen3-embedding:4b`, Ollama                   |           0.773 |        0.963 |            0.406 |         0.315 |    0.811 |
| `harrier-oss-v1-0.6b`, TEI                     |           0.766 |        0.960 |            0.376 |         0.284 |    0.763 |
| EmbeddingGemma 300M `q8` (in-process default)  |           0.779 |        0.961 |            0.389 |         0.302 |    0.736 |
| EmbeddingGemma 2 `q8`                          |           0.864 |        0.970 |            0.359 |         0.279 |    0.780 |

How to read it:

- Each model gets its library default prompt for every set, as an app does. MTEB uses a prompt written per task, so leaderboard numbers for Qwen3 and Harrier are higher.
- `qwen3-embedding:4b` was measured before it joined `./ollama`'s facts table: 2,560 dims and Qwen3's prefixes, as now, but with the 2,048-token limit for unknown models, not 32,768.
- Harrier ran in `ghcr.io/huggingface/text-embeddings-inference:cpu-arm64-latest` (`sha256:5d32815d…`), revision `f9b9dc8`, with `--max-batch-tokens 8192`.
- BM25 has no stemming. BEIR's published BM25 (Elasticsearch, English analyzer) is 0.665 and 0.325.
- Self-check: 0.7005 through the library, 0.7005 bare. The wrapper changes nothing.

The defaults stay as they are. A default changes only when the new model loses no more than 0.01 nDCG@10 on the Romanian and app corpora it will serve. Those cannot be measured yet: the Romanian set has 1,419 passages and no graded queries.

### Reranking quality

`bun run eval:rerank` (`bench/quality/rerank.eval.ts`) takes the top 50 of `qwen3-embedding:0.6b` (Ollama) for each query and scores them again with each reranker. Every reranker reads the same 50 passages, so the change is the reranker's alone. It runs on the first 100 test queries by id of SciFact, NFCorpus and [FiQA](https://huggingface.co/datasets/mteb/fiqa) (BEIR, pinned by commit and sha256), with `onTooLong: 'truncate'`.

Run on 2026-10-23, Apple Silicon, both models in-process (Transformers.js, `q8`, CPU).

| Set      | Reranker              | nDCG@10 before | nDCG@10 after |      Δ | MRR@10 before | MRR@10 after | s/query p50 |
| -------- | --------------------- | -------------: | ------------: | -----: | ------------: | -----------: | ----------: |
| SciFact  | `bge-reranker-v2-m3`  |          0.704 |         0.721 | +0.017 |         0.665 |        0.682 |          17 |
| SciFact  | `Qwen3-Reranker-0.6B` |          0.704 |         0.728 | +0.024 |         0.665 |        0.699 |          25 |
| NFCorpus | `bge-reranker-v2-m3`  |          0.352 |         0.354 | +0.002 |         0.532 |        0.553 |          16 |
| NFCorpus | `Qwen3-Reranker-0.6B` |          0.352 |         0.358 | +0.006 |         0.532 |        0.546 |          25 |
| FiQA     | `bge-reranker-v2-m3`  |          0.494 |         0.523 | +0.030 |         0.549 |        0.568 |          22 |
| FiQA     | `Qwen3-Reranker-0.6B` |          0.494 |         0.453 | −0.040 |         0.549 |        0.487 |          22 |

How to read it:

- `bge-reranker-v2-m3` helps on every set, by 0.002 to 0.030. The target in the plan was +0.05 on two of three sets. It is not met.
- `Qwen3-Reranker-0.6B` helps on SciFact and NFCorpus but makes FiQA worse. Why is not known yet. It uses the prompt from Qwen's model card; FiQA's financial questions may need a task instruction of their own.
- The hosted rerankers (Cohere, Voyage, Jina) and the server ones (TEI, Cohere-compatible) were not run: no keys or servers were set. The eval prints them as not run.
- 100 queries per set is a sample. A difference under about 0.01 can be noise.
- The seconds per query are rough: the machine was busy, and each query scores 50 passages on the CPU. `bench/rerank.bench.ts` is the timing.

## Benchmarks

<!-- bench:start -->

No published numbers yet. README numbers come only from `bun run bench --profile publish --write-readme` on an idle machine.

<!-- bench:end -->

## Documentation

- [Agent guide](docs/agent-guide.md): tasks and rules for agents.
- [Set up embeddings](docs/recipes/set-up-embeddings.md): Ollama locally, a hosted provider from your own settings.
- [llms.txt](llms.txt): the import map.

## Support

Report bugs at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues).

## License

MIT
