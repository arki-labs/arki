# @arki/embeddings

Text → vectors for ARKI. One `Embedder` shape over every provider, every response checked, every expected failure returned as a value.

## Install

```sh
bun add @arki/embeddings @arki/failure
```

`@arki/failure` gives you `isFailure`. The `./openai` entry also needs the optional peers `ai` and `@ai-sdk/openai`; `./transformers` needs the optional peer `@huggingface/transformers`. The root, `./ollama`, `./openai-compatible`, `./env` and `./testing` need no peer.

## Quick start

Embed documents with whichever provider the environment configures. The imports come from `@arki/embeddings` and `@arki/failure`.

```ts from="examples/index-documents.ts#embed-documents"
/** Picks the model from the environment, then embeds every text. The first failure comes back as the value. */
export async function embedDocuments(texts: readonly string[], env: EnvSource) {
  const model = resolveEmbeddingModel(undefined, env); // ollama → openai → voyage → google
  if (isFailure(model)) return model;
  const embedder = createEmbedder(model);
  if (isFailure(embedder)) return embedder;
  return embedMany(embedder, texts, { purpose: 'document' });
}
```

Call it with `process.env`. Store `spaceId(batch.space)` next to your index, so you can tell later which model made the vectors.

- **Checked output.** Every response must have one vector per input, the expected dimensions, only finite numbers and a non-zero norm. Anything else is `InvalidOutput`, and the whole batch is discarded.
- **All or nothing.** `embedMany` packs inputs by the model's `maxBatch` and `maxBatchTokens`, runs chunks with bounded concurrency (default 2) and keeps input order. The first failure cancels the remaining chunks and is returned with no vectors.
- **Spaces.** `EmbeddingSpace` says which vectors are comparable: provider, model, revision, dimensions, normalisation, dtype and instruction version. Store `spaceId(space)` next to your index; `isSameSpace` and `resolveEmbeddingModel(…, undefined, { requiredSpace })` refuse a different one with `SpaceMismatch`.

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
- Reranking, caching and telemetry wrappers. They are not in this release.
- Images, sparse vectors and multi-vector output. The types exist, and no adapter produces them yet.
- Meaning-based assertions in tests with `fakeEmbedder`. Its vectors are not semantic (see [Testing](#testing)).

## Runtime support

The root, `./ollama`, `./openai-compatible`, `./env`, `./kv` and `./testing` use only `fetch` and run on Node, Bun, Deno, in the browser and on Hermes. `./openai` loads its AI SDK peers on the first call, not at import, and needs Node or Bun. `./dot` needs `@arki/dot`, so Node or Bun. `./transformers` runs ONNX Runtime in process: Node and Bun (CPU), and the browser through Transformers.js' WebGPU or WASM backend. It does not run on Hermes, and Deno is not claimed. Its smoke check downloads the model, so it runs only with `TRANSFORMERS_SMOKE=1`, and only on the Node and Bun legs: the browser is not yet covered by a smoke. The root imports no provider SDK, no `process.env` and no `node:*`.

Debug logs use the `arki:embeddings` category. Show them with `DEBUG=arki:embeddings`.

## Public imports

| Entry                                | What it is                                                                                                                                                                                                                                                                                                       | Peers                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `@arki/embeddings`                   | types, `createEmbedder`, `embed`, `embedMany`, `embedStream`, `withResilience`, `withCache`, `memoryCacheStore`, `withTelemetry`, `withMiddleware`, `resolveEmbeddingModel`, `resolveSpace`, `spaceId`, `isSameSpace`, `cosine`, `l2Normalize`, `norm`, `truncate`, `quantize`, `calibrateInt8`, `unpackBits`, `hamming`, `countTokens`, `normalizeText`, the `*_INSTRUCTION` tables, the failures | none                                   |
| `@arki/embeddings/ollama`            | `createOllamaModel({ id?, baseURL?, keepAlive?, dimensions?, fetch? })` over `fetch` `/api/embed`                                                                                                                                                                                                                | none                                   |
| `@arki/embeddings/openai`            | `createOpenAIModel({ id?, apiKey, baseURL? })` through the AI SDK                                                                                                                                                                                                                                                | `@ai-sdk/openai`, `ai` (optional)      |
| `@arki/embeddings/openai-compatible` | `createOpenAICompatibleModel({ id, baseURL, dimensions, apiKey?, … })` for any server that speaks `/embeddings`                                                                                                                                                                                                  | none                                   |
| `@arki/embeddings/env`               | `resolveEmbeddingConfig(env)`: validates the embedding variables with `@arki/env`                                                                                                                                                                                                                                | none                                   |
| `@arki/embeddings/kv`                | `kvCacheStore(kv, { prefix? })`: a `CacheStore` over an `@arki/kv` client (anything with its `get` and `set`)                                                                                                                                                                                                    | none                                   |
| `@arki/embeddings/dot`               | `embeddings({ model?, cache?, resilience?, env? })`: the app's embedder as a Dot plugin                                                                                                                                                                                                                          | `@arki/dot` (optional)                 |
| `@arki/embeddings/transformers`      | `await createTransformersModel({ id?, revision?, dtype?, device?, cacheDir?, onProgress?, instruction? })`: a model run in process, EmbeddingGemma `q8` by default                                                                                                                                               | `@huggingface/transformers` (optional) |
| `@arki/embeddings/testing`           | `fakeEmbedder({ dimensions, seed?, failures?, delayMs? })`                                                                                                                                                                                                                                                       | none                                   |

`resolveEmbeddingModel` is pure: it never touches the network. Ollama's model digest (the space `revision`) is read from `/api/tags` on the first call, so `revision` is `undefined` until then; `isSameSpace` tolerates a missing revision on one side. To compare with stored space ids before anything is embedded (a job that looks for stale rows), `await resolveSpace(embedder)` reads the digest without embedding and answers the full space, or `ModelUnavailable` (`unreachable` or `not-pulled`).

### Variables

`EMBEDDING_MODEL` (`provider:model`, e.g. `ollama:qwen3-embedding:0.6b`), `OLLAMA_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `VOYAGE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`. Without `EMBEDDING_MODEL`, the first configured provider in the order `ollama → openai → voyage → google` wins. Nothing configured is `ConfigurationFailure`. Voyage and Google records arrive in a later release; until then they resolve to `ConfigurationFailure`.

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

`embeddings({ model?, cache?, resilience?, env? })` from `@arki/embeddings/dot` publishes `embedder` (`Embedder | null`), built once at boot. `model` is a ref, a model record, an `Embedder`, or a function returning one of the last two or a failure; without it, `resolveEmbeddingModel` reads `env` (default `process.env`). `cache: true` adds `withCache` over a `memoryCacheStore()`, or pass a store; `resilience: true` adds `withResilience`, or pass a policy. The cache sits outside the retries. A configuration that does not resolve is logged once at `warn` and `embedder` is `null`, so the app boots and features degrade.

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

| Table                        | Models                                   | `query`                          | `document`              |
| ---------------------------- | ---------------------------------------- | -------------------------------- | ----------------------- |
| `QWEN3_INSTRUCTION`          | Qwen3-Embedding (Ollama default)         | `Instruct: … Query: `            | none                    |
| `EMBEDDINGGEMMA_INSTRUCTION` | `embeddinggemma`                         | `task: search result \| query: ` | `title: none \| text: ` |
| `NOMIC_INSTRUCTION`          | `nomic-embed-text`                       | `search_query: `                 | `search_document: `     |
| `E5_INSTRUCTION`             | E5 family, through `./openai-compatible` | `query: `                        | `passage: `             |
| `NO_INSTRUCTION`             | OpenAI, the fake                         | none                             | none                    |

EmbeddingGemma and nomic also have `classification` and `clustering` prefixes; EmbeddingGemma has `similarity`.

## Smaller vectors

Three ways to shrink a vector, from most to least faithful:

- **Matryoshka sizes.** `createEmbedder(model, { dimensions: 256 })` asks for a size from `model.matryoshka`. `truncate(vector, 256, model)` does the same to a vector you already have: it keeps the first 256 values and re-normalises them when the model's vectors are unit length. Any other size is `UnsupportedInput`.
- **Int8**, one byte per dimension. Each value is mapped from a per-dimension `[min, max]` onto -128…127. The range comes from `calibrateInt8(sample)` over a sample of *your corpus*, and the whole corpus must share it: vectors scaled differently are not comparable. With `createEmbedder(model, { quantization: 'int8', calibration })` the space id names the calibration (`…/i8@<16 hex>/…`), so an index made with another range is a different space. Without a calibration, int8 works only when the provider makes it natively.
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

## Benchmarks

<!-- bench:start -->

No published numbers yet. README numbers come only from `bun run bench --profile publish --write-readme` on an idle machine.

<!-- bench:end -->

## Documentation

- [Agent guide](docs/agent-guide.md): tasks and rules for agents.
- [Set up embeddings](docs/recipes/set-up-embeddings.md): Ollama by default, `EMBEDDING_MODEL`, OpenAI when configured.
- [llms.txt](llms.txt): the import map.

## Support

Report bugs at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues).

## License

MIT
