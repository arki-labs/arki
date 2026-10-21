# @arki/embeddings

Text → vectors for ARKI. One `Embedder` shape over every provider, every response checked, every expected failure returned as a value.

## Install

```sh
bun add @arki/embeddings @arki/failure
```

`@arki/failure` gives you `isFailure`. The `./openai` entry also needs the optional peers `ai` and `@ai-sdk/openai`. The root, `./ollama`, `./openai-compatible`, `./env` and `./testing` need no peer.

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
- Reranking, caching, retries and telemetry wrappers. They are not in this release.
- Images, sparse vectors and multi-vector output. The types exist, and no adapter produces them yet.
- Meaning-based assertions in tests with `fakeEmbedder`. Its vectors are not semantic (see [Testing](#testing)).

## Runtime support

The root, `./ollama`, `./openai-compatible`, `./env` and `./testing` use only `fetch` and run on Node, Bun, Deno, in the browser and on Hermes. `./openai` loads its AI SDK peers on the first call, not at import, and needs Node or Bun. The root imports no provider SDK, no `process.env` and no `node:*`.

Debug logs use the `arki:embeddings` category. Show them with `DEBUG=arki:embeddings`.

## Public imports

| Entry                                | What it is                                                                                                                                                                                            | Peers                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `@arki/embeddings`                   | types, `createEmbedder`, `embed`, `embedMany`, `resolveEmbeddingModel`, `spaceId`, `isSameSpace`, `cosine`, `l2Normalize`, `norm`, `countTokens`, `QWEN3_INSTRUCTION`, `NO_INSTRUCTION`, the failures | none                              |
| `@arki/embeddings/ollama`            | `createOllamaModel({ id?, baseURL?, keepAlive?, dimensions?, fetch? })` over `fetch` `/api/embed`                                                                                                     | none                              |
| `@arki/embeddings/openai`            | `createOpenAIModel({ id?, apiKey, baseURL? })` through the AI SDK                                                                                                                                     | `@ai-sdk/openai`, `ai` (optional) |
| `@arki/embeddings/openai-compatible` | `createOpenAICompatibleModel({ id, baseURL, dimensions, apiKey?, … })` for any server that speaks `/embeddings`                                                                                       | none                              |
| `@arki/embeddings/env`               | `resolveEmbeddingConfig(env)`: validates the embedding variables with `@arki/env`                                                                                                                     | none                              |
| `@arki/embeddings/testing`           | `fakeEmbedder({ dimensions, seed?, failures?, delayMs? })`                                                                                                                                            | none                              |

`resolveEmbeddingModel` is pure: it never touches the network. Ollama's model digest (the space `revision`) is read from `/api/tags` on the first call, so `revision` is `undefined` until then; `isSameSpace` tolerates a missing revision on one side.

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

## Limits

- **A request is one provider call of at most `maxBatch` inputs and `maxBatchTokens` tokens.** `embedMany` splits larger work for you. One input that alone costs more than `maxBatchTokens` is refused with `InputTooLong` before any request is sent.
- **Token counts are estimates in this release:** `ceil(characters / 4)`. A provider's own count replaces it in the result when the provider reports one.
- **Dimensions** must be the model's native size or one of its Matryoshka sizes. Any other size is `UnsupportedInput`, not a silent resize.
- **Texts are never changed.** There is no normalisation, so the same text in a different Unicode form is a different input.
- **A failed batch has no partial result.** If chunk 7 of 10 fails, you get the failure and none of the vectors.

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
