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

The services (`OpenAIService`, `AnthropicService`, `OllamaService`, ...) return the same `ProviderFailure` values: a full rate limiter or a provider 429 is `RateLimited`, a cut-off answer `IncompleteGeneration`. `OpenAIService` with `sanitize` on also returns `InputBlocked` for a refused prompt. Check with `isFailure(result)`.

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
import { isFailure } from '@arki/failure';

const llm = createFakeLLMProvider({ answers: [{ planet: 'Mars' }] });
const planet = await llm.generateStructuredData('Name one planet.', z.object({ planet: z.string() }));

console.log(isFailure(planet) ? planet.code : planet.planet, llm.calls.length);
```

```text
Mars 1
```

Pass `answers` as a function of the call (`call.prompt`, `call.system`, `call.jsonSchema`) when the order of calls is not fixed. A call past the last scripted answer returns `UnexpectedDefect`.

### Embed and search

Make vectors with `@arki/embeddings`. Build the index from `embedder.space`. See [Embeddings and the vector index](reference.md#embeddings-and-the-vector-index).

### Run a tool loop

See [The tool loop](reference.md#the-tool-loop). Define tools with `defineAgentTool`. Return a failure from `execute` for an expected outcome, and let a thrown error mean a bug.

### Handle a rate limit

```ts skip="needs a running model"
import { isFailure } from '@arki/failure';
import { RateLimited, OpenAIService } from '@arki/ai';

const service = new OpenAIService({ model: 'gpt-4o-mini' });
const stream = await service.streamText('Tell me a story');
if (RateLimited.is(stream)) {
  console.log(`retry in ${stream.data.retryAfterMs} ms`);
} else if (!isFailure(stream)) {
  for await (const chunk of stream) {
    // When the stream fails or stops early, its last item is the failure.
    if (isFailure(chunk)) console.log(chunk.code);
    else process.stdout.write(chunk);
  }
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
- A `registerTelemetry` hook (`@arki/ai/sdk`) sees every `@arki/ai` call, next to the spans. Register it once at boot; it is read at each call.
- `ToolOutputError` is thrown by the runtime in place of a bad tool result. The model never sees the bad value.
- Do not promise browser support for the server entries.

## Errors

| Code | Class or failure | Fix |
| --- | --- | --- |
| `ai.rate_limited` | `RateLimited` (returned) | Wait `data.retryAfterMs`, retry. |
| `ai.budget_exceeded` | `BudgetExceeded` (returned) | Wait for the period to reset, or raise the limit. |
| `ai.circuit_open` | `CircuitOpen` (returned by `CostCircuitBreaker.execute`) | Wait `data.retryAfterMs`, or raise `costThresholdUsd`. |
| `ai.keyword_search_unavailable` | `KeywordSearchUnavailable` (returned by `SemanticSearchService.search`) | Pass a `KeywordSearchProvider`, or use `semantic` mode. |
| `ai.provider_unavailable` | `ProviderUnavailable` (returned by `probeLLMProvider`, boot failure of `llm()`) | `data.problem`: `unreachable` → start Ollama or the server; `model_missing` → `ollama pull <model>`; `missing_key` → set the key. |
| `ai.unauthorized` | `ProviderUnauthorized` (returned) | The provider refused the key (401 or 403), or no key is set. Set a valid key. |
| `ai.content_filtered` | `ContentFiltered` (returned) | The provider's filter stopped the answer, or the model refused. Change the prompt. |
| `ai.invalid_output` | `InvalidOutput` (returned) | The answer had no text, bad JSON, or JSON the schema rejects. Simplify the schema or use a stronger model. |
| `ai.provider_failed` | `ProviderFailed` (returned) | Server error, timeout or network failure. Retry later or fall back to another provider. |
| `ai.cancelled` | `Cancelled` (returned) | The caller aborted through its `AbortSignal`. Start a new call if you still need the answer. |
| `ai.all_providers_failed` | `AllProvidersFailed` (returned by the provider router) | Every provider failed; `data.failures` lists each code. Fix each one, or add a provider. |
| `ai.no_provider_configured` | `NoProviderConfigured` (returned by the provider router) | No provider is enabled or has a key. Enable one, or run Ollama. |
| `ai.connection_lost` | `ConnectionLost` (returned) | The connection broke before the answer finished. Retry. |
| `ai.ungrounded_output` | `UngroundedOutput` (returned by the task functions) | The answer is not backed by its source; `data.reason` says why. Retry or use a stronger model. |
| `ai.flow_timed_out` | `FlowTimedOut` (returned by a flow) | A node ran past its `timeoutMs`. Raise it, or make the node faster. |
| `ai.flow_step_limit` | `FlowStepLimitReached` (returned by a flow) | The flow passed `maxSteps`, usually a `next` that loops. End the loop or raise `maxSteps`. |
| `ai.flow_node_failed` | `FlowNodeFailed` (returned by a flow) | A node still threw after all retries. Read `cause`. |
| `ai.vector_store_unavailable` | `VectorStoreUnavailable` (returned) | The vector store could not be reached. Check that Qdrant is up. |
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
