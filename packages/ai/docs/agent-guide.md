# @arki/ai for agents

Read this before changing code that calls a model. The [README](../README.md) is the overview and the [reference](reference.md) holds the long guides.

## The model

- A **provider** is chosen by `LLM_PROVIDER`. Unset means Ollama. `createLLMProvider()` returns an `LLMProviderWithUsage`: a `StructuredLLMProvider` (`generateStructuredData`, `generateText` and friends) plus `generateStructuredResult` and `generateTextResult`, which return `{ value, usage, provider, model }`. The services (`OllamaService`, `OpenAIService`, `AnthropicService`, ...) share the `StructuredLLMProvider` method shapes.
- **`probeLLMProvider()`** says whether that provider can be called now. It returns `ProviderUnavailable` instead of throwing.
- **`createFakeLLMProvider`** (`@arki/ai/testing`) is the test double: scripted answers, fixed usage, no HTTP.
- **Embeddings** are not made here. Use `@arki/embeddings`; the vector index is sized from `embedder.space`.
- The **vector index** (`createVectorIndex`) is Qdrant when `QDRANT_URL` is set (`durable: true`) and in memory otherwise. `runVectorReconciliation` drains erasure tombstones and repairs drift. It runs from cron.
- The **tool loop** (`createAiSdkRuntime(...).runToolLoop`) streams `RuntimeEvent`s. Tools come from `defineAgentTool`, with an `inputSchema` and an `output` schema.
- **`createFlow`** runs named nodes in memory. It is not durable. `Flow.run` returns retry-wait `UnexpectedDefect` outcomes unchanged, alongside inferred node refusals; these stop retries and success persistence.
- Expected refusals are **returned**: `RateLimited` and `BudgetExceeded` from `@arki/ai`, and any failure a tool returns.

## Task map

### Generate structured data

```ts skip="needs a running model"
import { z } from 'zod';

import { RateLimited, createLLMProvider } from '@arki/ai';

const llm = createLLMProvider();
const result = await llm.generateStructuredData('Name one planet.', z.object({ planet: z.string() }));
```

`generateStructuredData` on `OpenAIService` can also return `RateLimited`. Check it with `RateLimited.is(result)`.

Need the token counts? Call `llm.generateStructuredResult(...)` instead: the same call, returning `{ value, usage }`. Price it with `priceOf({ provider, model, inputTokens, outputTokens })`: a local provider costs 0 (`basis: 'local'`), an unknown hosted model gets the default rate (`basis: 'default-rate'`).

### Check the provider before the first call

```ts skip="needs a running Ollama"
import { createLLMProvider, probeLLMProvider, ProviderUnavailable } from '@arki/ai';

const ready = await probeLLMProvider();
if (ProviderUnavailable.is(ready)) console.log(ready.data.problem); // 'unreachable' | 'model_missing' | 'missing_key'
else console.log(await createLLMProvider(ready).generateText('Say hi.'));
```

### Test without a model

```ts run expect
import { z } from 'zod';

import { createFakeLLMProvider } from '@arki/ai/testing';

const llm = createFakeLLMProvider({ answers: [{ planet: 'Mars' }] });
const planet = await llm.generateStructuredData('Name one planet.', z.object({ planet: z.string() }));

console.log(planet.planet, llm.calls.length);
```

```text
Mars 1
```

Pass `answers` as a function of the call (`call.prompt`, `call.system`, `call.jsonSchema`) when the order of calls is not fixed. A call past the last scripted answer throws.

### Embed and search

Make vectors with `@arki/embeddings`. Build the index from `embedder.space`. See [Embeddings and the vector index](reference.md#embeddings-and-the-vector-index).

### Run a tool loop

See [The tool loop](reference.md#the-tool-loop). Define tools with `defineAgentTool`. Return a failure from `execute` for an expected outcome, and let a thrown error mean a bug.

### Handle a rate limit

```ts skip="needs a running model"
import { RateLimited, OpenAIService } from '@arki/ai';

const service = new OpenAIService({ model: 'gpt-4o-mini' });
const stream = await service.streamText('Tell me a story');
if (RateLimited.is(stream)) {
  console.log(`retry in ${stream.data.retryAfterMs} ms`);
} else {
  for await (const chunk of stream) process.stdout.write(chunk);
}
```

### Wire the vector index into a Dot app

Use `vectorIndex({ collection, payloadIndexes })` from `@arki/ai/dot`. It provides `embedder` and `vectorIndex` once, at boot. `vectorIndex.provider` is `null` when nothing is configured.

### Wire the model provider into a Dot app

Use `llm(() => config)` from `@arki/ai/dot`. It provides `llm` (an `LLMProviderWithUsage`) and probes the provider at boot: an unusable one fails boot with `ProviderUnavailable`, and `dot doctor` marks the `llm` plugin failed. Pass `probe: false` for an app that must boot without a model. In tests pass `instance: createFakeLLMProvider(...)`.

## Rules that bite

- Do not default to a cloud provider. Ollama first; a cloud provider needs `LLM_PROVIDER` or a key.
- Do not make vectors here. Use `@arki/embeddings`.
- Do not iterate a stream before you check for `RateLimited`.
- Do not log a cost from a hardcoded model name.
- Pass the provider when you price a call (`priceOf` or `calculateLLMCost(..., { provider })`). Without it a local model is priced at the hosted default rate.
- Generation spans carry prompts and completions whenever a tracer provider is registered. Set `AI_TELEMETRY=off` where prompts must not reach traces.
- `ToolOutputError` is thrown by the runtime in place of a bad tool result. The model never sees the bad value.
- Do not promise browser support for the server entries.

## Errors

| Code | Class or failure | Fix |
| --- | --- | --- |
| `ai.rate_limited` | `RateLimited` (returned) | Wait `data.retryAfterMs`, retry. |
| `ai.budget_exceeded` | `BudgetExceeded` (returned) | Wait for the period to reset, or raise the limit. |
| `ai.provider_unavailable` | `ProviderUnavailable` (returned by `probeLLMProvider`, boot failure of `llm()`) | `data.problem`: `unreachable` → start Ollama or the server; `model_missing` → `ollama pull <model>`; `missing_key` → set the key. |
| `CONFIGURATION_ERROR` | `ConfigurationError` | Set the variable or option the message names. |
| `EMBEDDING_ERROR` | `EmbeddingError` | Check the embedding provider, model and dimensions. |
| `VECTOR_SEARCH_ERROR` | `VectorSearchError` | Check the vector store and the collection. |
| `GENERATION_ERROR` | `GenerationError` | Check the provider and the model; read `cause`. |
| `VALIDATION_ERROR` | `ValidationError` | Read `validationErrors` and fix the input. |
| `TOOL_OUTPUT_ERROR` | `ToolOutputError` | Fix the tool's `execute` so it matches `output`. |

## Verify

```sh
turbo run build typecheck lint test --filter=@arki/ai
cd packages/ai && bun run test:docs
cd packages/ai && bun ../../tooling/library/src/llms.ts --check
dot explain --json | jq .data.services   # in an app using @arki/ai/dot: lists embedder, vectorIndex and llm
dot doctor --json | jq .data             # in that app: no missing ai service; the llm plugin is ok when the provider answers
```
