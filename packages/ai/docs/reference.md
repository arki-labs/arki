# @arki/ai reference

Long guides for the pieces of `@arki/ai`. The [README](../README.md) has the overview.

## Generate text and structured data

`createLLMProvider()` reads `LLM_PROVIDER` (default `ollama`) and `LLM_MODEL`. It returns one interface for every provider.

```ts skip="needs a running model"
import { z } from 'zod';

import { createLLMProvider } from '@arki/ai';

const llm = createLLMProvider();
const summary = await llm.generateStructuredData('Summarise: ...', z.object({ title: z.string(), points: z.array(z.string()) }));
```

- `schema` is any Standard Schema (zod, valibot, arktype). The model is shown the schema's input JSON Schema. You get the schema's output type back, with transforms run.
- A schema that cannot emit JSON Schema throws a `ConfigurationError` that names `withJsonSchema` from `@arki/schema`.
- `OpenAIService` checks a local rate limiter first. With no free slot it returns `RateLimited` instead of calling the model. Provider faults throw `GenerationError`.
- `OllamaService` uses Ollama's native `format` parameter for constrained decoding, so output matches the schema at the token level.
- `generateStructuredResult` and `generateTextResult` make the same calls and return `{ value, usage, provider, model }`. `usage` has the AI SDK's `inputTokens` and `outputTokens` (summed over all steps; `undefined` when the provider does not report them). Price them with `priceOf` from `@arki/ai/cost`.
- `probeLLMProvider()` checks the same provider and model before a call: Ollama answers and has the model, an OpenAI-compatible `baseURL` answers, or a cloud key is set. It returns `ProviderUnavailable` instead of throwing.
- Spans: every call reports `gen_ai` spans (with the prompt and completion) to the registered OpenTelemetry tracer provider. With none registered nothing is recorded. `AI_TELEMETRY=off` turns them off.
- `StructuredGenerator` (import it from `@arki/ai/ai-service/structured-generation`) wraps a provider with `generateSummary`, `answerQuestion`, `classifyText`, `extractEntities` and `analyzeSentiment`.

## Embeddings and the vector index

One env reader, local first. The core never reads `process.env`: pass the map in.

```ts skip="needs Ollama or OpenAI and a vector store"
import { createEmbedder, createEmbeddingRuntime, createVectorIndex } from '@arki/ai';

// EMBEDDING_PROVIDER, else Ollama (OLLAMA_BASE_URL / OLLAMA_HOST), else OpenAI, else null.
const runtime = await createEmbeddingRuntime(process.env);
const embedder = createEmbedder(runtime); // embedQuery(text, expectedDimensions?) gives { vector, selection } or null

type Payload = { userId: string; kind: 'item' | 'chunk'; model: string; dimensions: number };
const index =
  runtime &&
  createVectorIndex<Payload>(runtime, {
    collection: 'app_embeddings',
    payloadIndexes: ['userId', 'kind'],
    env: process.env,
  });
// index.provider is Qdrant when QDRANT_URL is set (durable: true), else the in-memory store (durable: false).
```

`runVectorReconciliation` drains erasure tombstones (durable index only), migrates dimension mismatches, re-upserts current rows, then deletes points whose rows stopped being current while they were upserted. Run it from cron. Each call handles at most `ROW_CAP_PER_RUN` rows and `TOMBSTONE_CAP_PER_RUN` tombstones.

- `@arki/ai/dot`: `vectorIndex({ collection, payloadIndexes, env?, runtime?, provider? })` provides `embedder` and `vectorIndex`. Resolved once at boot. Optional peer: `@arki/dot`.
- `@arki/ai/drizzle`: `createTombstoneTable<UserId>(schema, { name, idPrefix })` and `tombstoneOutbox(table)` with `write(tx, userId, pointIds)` (in the delete's transaction), `clear(db, pointIds)` and `store(db)`. Optional peers: `drizzle-orm`, `@arki/db`.

## The tool loop

`createAiSdkRuntime` runs a tool loop behind the framework-neutral `AgentRuntime` contract. Define tools with `defineAgentTool`: `execute`'s input type comes from `inputSchema`, and its return type comes from `output`.

```ts skip="needs a model and a weather service"
import { z } from 'zod';

import { createAiSdkRuntime, defineAgentTool } from '@arki/ai';
import { createOllama } from 'ai-sdk-ollama';

const weather = defineAgentTool({
  name: 'weather',
  description: 'Current temperature for a city.',
  inputSchema: z.object({ city: z.string() }),
  output: z.object({ celsius: z.number() }),
  async execute({ city }, { signal }) {
    const response = await fetch(`https://example.com/weather/${city}`, { signal });
    return { celsius: Number(await response.text()) };
  },
});

const controller = new AbortController();
const runtime = createAiSdkRuntime({ model: createOllama()('qwen3.6:latest') });
for await (const event of runtime.runToolLoop({ prompt: 'Oslo?', tools: [weather], signal: controller.signal })) {
  // run:start, text:delta, tool:start, tool:result, tool:failure, tool:error, run:finish
}
```

- **Cancel with `signal`.** After it aborts, the run starts no new model call or tool call. The model call in flight and every tool see the abort. The loop rejects with the signal's reason.
- **`inputSchema` is any Standard Schema that can emit JSON Schema.** Wrap one that cannot with `withJsonSchema` from `@arki/schema`.
- **`output` is checked.** The runtime checks each result against `output` before the model sees it. The model gets the parsed value. A mismatch fails that tool call with a `ToolOutputError` (code `TOOL_OUTPUT_ERROR`), which arrives as a `tool:error` event.
- **Return a failure for an expected outcome.** `execute` may return a failure from `@arki/failure`, such as `CityNotFound({ city })`. The model gets `{ error: { code, message, remediation, data } }`, so the remediation sentence can steer its next call. The `output` check is skipped and the run emits `{ type: 'tool:failure', tool, failure }`. A thrown error is still a `tool:error`. Both runtimes (AI SDK and Mastra) behave the same.
- **Spans.** When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the AI SDK's telemetry (`@ai-sdk/otel`) records one `step N` span per model step and one `execute_tool <name>` span per tool call. With no endpoint, or no OpenTelemetry SDK registered, nothing is recorded.

## Flows

`createFlow` runs its nodes in memory, inside one request or one job. It is not durable: a restart loses the run. Work that must survive process death, or that waits for hours, belongs in an `@arki/journal` workflow.

Nodes can return canonical `@arki/failure` values. Use `createFlow<State, Context>()(config)` to infer the exact union of failures from every node. `flow.run(...)` returns the final state or the original failure. A returned failure stops the flow before it merges state, retries, runs the next node or emits a success event.

For separately declared nodes, use `satisfies FlowNode<State, Context, Failure>` (with `Failure` from `@arki/failure`) to check the shape and keep each concrete return type. A type annotation with the broad `Failure` type erases that precision. `FlowConfig` and `Flow` accept a third generic for the whole node output type.

Thrown configuration, node, timeout, cancellation, checkpoint and retry-wait errors still reject. Only returned failures stop the flow as values.

## React

Components and hooks live in `@arki/ai/react` (optional peers `react` and `@ai-sdk/react`): `useAIChat`, `useAIGeneration`, `useRuntimeStream`, `useSemanticSearch`, `AIChat`, `StreamingText` and `SearchInterface`.

```tsx skip="needs a React app and a /api/chat route"
import { AIChat, useAIChat } from '@arki/ai/react';

export function ChatPanel() {
  const chat = useAIChat({ apiEndpoint: '/api/chat', streamResponse: true });
  return (
    <AIChat
      messages={chat.messages}
      input={chat.input}
      isLoading={chat.isLoading}
      onInputChange={chat.setInput}
      onSubmit={event => {
        event.preventDefault();
        chat.sendMessage();
      }}
    />
  );
}
```

## Types and validation

Search and service configuration types are inferred from their runtime schemas: `searchSettingsSchema`, `searchOptionsSchema`, `ragServiceConfigSchema` and `aiServiceConfigSchema`. `SearchSettings` holds query-less search settings; `SearchOptions` adds the required query and optional payload filters. `sanitizerConfigSchema` is available from `@arki/ai/safety` and `@arki/ai/validation`; custom injection and PII rules take real `RegExp` instances.
