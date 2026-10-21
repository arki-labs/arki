# @arki/ai for agents

Read this before changing code that calls a model. The [README](../README.md) is the overview and the [reference](reference.md) holds the long guides.

## The model

- A **provider** is chosen by `LLM_PROVIDER`. Unset means Ollama. `createLLMProvider()` returns a `StructuredLLMProvider` with `generateStructuredData`, `generateText` and friends. The services (`OllamaService`, `OpenAIService`, `AnthropicService`, ...) share those method shapes.
- **Embeddings** are selected once from an env map by `resolveEmbeddingSelection(env)`: `EMBEDDING_PROVIDER`, else Ollama, else OpenAI, else `null`.
- The **vector index** (`createVectorIndex`) is Qdrant when `QDRANT_URL` is set (`durable: true`) and in memory otherwise. `runVectorReconciliation` drains erasure tombstones and repairs drift. It runs from cron.
- The **tool loop** (`createAiSdkRuntime(...).runToolLoop`) streams `RuntimeEvent`s. Tools come from `defineAgentTool`, with an `inputSchema` and an `output` schema.
- **`createFlow`** runs named nodes in memory. It is not durable.
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

### Embed and search

Resolve the selection from an env map. `null` means nothing is configured.

```ts run expect
import { resolveEmbeddingSelection } from '@arki/ai';

console.log(resolveEmbeddingSelection({ EMBEDDING_PROVIDER: 'ollama' }));
```

```text
{
  type: "ollama",
  model: "qwen3-embedding:0.6b",
  dimensions: 1024,
}
```

Build the index and the embedder from the runtime. See [Embeddings and the vector index](reference.md#embeddings-and-the-vector-index).

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

## Rules that bite

- Do not default to a cloud provider. Ollama first; a cloud provider needs `LLM_PROVIDER` or a key.
- Do not read embedding variables anywhere except `src/embeddings/runtime.ts`.
- Do not iterate a stream before you check for `RateLimited`.
- Do not log a cost from a hardcoded model name.
- `ToolOutputError` is thrown by the runtime in place of a bad tool result. The model never sees the bad value.
- Do not promise browser support for the server entries.

## Errors

| Code | Class or failure | Fix |
| --- | --- | --- |
| `ai.rate_limited` | `RateLimited` (returned) | Wait `data.retryAfterMs`, retry. |
| `ai.budget_exceeded` | `BudgetExceeded` (returned) | Wait for the period to reset, or raise the limit. |
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
dot explain --json | jq .data.services   # in an app using @arki/ai/dot: lists embedder and vectorIndex
dot doctor --json | jq .data             # in that app: no missing ai service
```
