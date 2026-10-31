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

Text to vectors is `@arki/embeddings`. This package stores and ranks vectors. The core never reads `process.env`: pass the map in.

```ts skip="needs an embedder and a vector store"
import { createVectorIndex } from '@arki/ai';
import type { Embedder } from '@arki/embeddings';

declare const embedder: Embedder; // from `createEmbedder(...)` in `@arki/embeddings`

type Payload = { userId: string; kind: 'item' | 'chunk' };
const index = createVectorIndex<Payload>(embedder.space, {
  collection: 'app_embeddings',
  payloadIndexes: ['userId', 'kind'],
  env: process.env,
});
// index.provider is Qdrant when QDRANT_URL is set (durable: true), else the in-memory store (durable: false).
```

`runVectorReconciliation` drains erasure tombstones (durable index only), migrates dimension mismatches, re-upserts current rows, then deletes points whose rows stopped being current while they were upserted. Run it from cron. Each call handles at most `ROW_CAP_PER_RUN` rows and `TOMBSTONE_CAP_PER_RUN` tombstones.

- `@arki/ai/dot`: `vectorIndex({ collection, payloadIndexes, env?, runtime?, provider? })` provides `embedder` and `vectorIndex`. Resolved once at boot. Optional peer: `@arki/dot`.
- `@arki/ai/drizzle`: `createTombstoneTable(pgColumns(schema), { name, idPrefix, userId })` and `tombstoneOutbox(table)` with `write(tx, userId, pointIds)` (in the delete's transaction), `clear(db, pointIds)` and `store(db)`. `@arki/ai/drizzle/sqlite` is the SQLite twin (`createTombstoneTable(sqliteColumns(), …)`, `sqliteTombstoneOutbox`). Optional peers: `drizzle-orm`, `@arki/db`.

## The tool loop

`createAiSdkRuntime` runs a tool loop behind the framework-neutral `AgentRuntime` contract. Define tools with `defineAgentTool`: `execute`'s input type comes from `inputSchema`, and its return type comes from `output`.

```ts skip="needs a model and the oven service"
import { z } from 'zod';

import { createAiSdkRuntime, defineAgentTool } from '@arki/ai';
import { createOllama } from 'ai-sdk-ollama';

const ovenTemperature = defineAgentTool({
  name: 'oven_temperature',
  description: 'Current temperature of the pizza oven.',
  inputSchema: z.object({}),
  output: z.object({ celsius: z.number() }),
  async execute(_input, { signal }) {
    const response = await fetch('https://oven.example/temperature', { signal });
    return { celsius: Number(await response.text()) };
  },
});

const controller = new AbortController();
const runtime = createAiSdkRuntime({ model: createOllama()('qwen3.6:latest') });
for await (const event of runtime.runToolLoop({ prompt: 'Is the oven hot enough for a margherita?', tools: [ovenTemperature], signal: controller.signal })) {
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

`generationResultSchema` and `searchResultSchema` are the Zod schemas for what `useAIGeneration` and `useSemanticSearch` read from the server. Use them to check those response bodies.

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

Search and service configuration types are plain TS types, and each one is the source. Their runtime schemas come from `@arki/ai/zod`: `searchSettingsSchema`, `searchOptionsSchema`, `ragServiceConfigSchema` and `aiServiceConfigSchema`, locked to the types by exact two-way type tests. `SearchSettings` holds query-less search settings; `SearchOptions` adds the required query and optional payload filters. `sanitizerConfigSchema` is available from `@arki/ai/safety`; custom injection and PII rules take real `RegExp` instances.

## Provider services and the router

`createLLMProvider` picks one provider from `LLM_PROVIDER` (or the `provider` option). Each hosted provider also has its own class and factory, for when you want exactly one and its own settings.

- `GoogleService` / `createGoogleService`: Gemini models. Import it from `@arki/ai/google`.
- `GroqService` / `createGroqService`: Groq's fast hosted open models (`@arki/ai/groq`).
- `MistralService` / `createMistralService`: Mistral models (`@arki/ai/mistral`).
- `OpenRouterService` / `createOpenRouterService`: OpenRouter, one key for many models, including free ones.
- `createAnthropic(settings)`: the AI SDK Anthropic factory. It also sends the `anthropic-workspace-id` header when `ANTHROPIC_WORKSPACE_ID` is set. A user-scoped key (`sk-ant-usr...`) needs it; a workspace key does not (`@arki/ai/anthropic`).
- `LLM_PROVIDERS`: the list of provider names, written once. `LLM_PROVIDER`, the provider config and the `ProviderUnavailable` failure all read it.
- `resolveLlmProvider(config)`: the provider `createLLMProvider` would use: the explicit `provider`, else `LLM_PROVIDER`, else Ollama.
- `DEFAULT_LLM_PROVIDER` (`ollama`) and `DEFAULT_OLLAMA_BASE_URL` (`http://127.0.0.1:11434`): the fallbacks used when env validation is skipped. A skipped schema applies no defaults, so these stop the code from silently choosing a paid provider.
- `DEFAULT_ANTHROPIC_MODEL`: the model used when `LLM_PROVIDER=anthropic` and no `LLM_MODEL` is set.
- `PROVIDER_PROBLEMS` and `DEFAULT_PROBE_TIMEOUT_MS`: `probeLLMProvider` reports one of `unreachable`, `model_missing` or `missing_key`. It waits 2000 ms for a server that does not answer.

`ProviderRouter` spreads calls over several providers. It does weighted round-robin, fails over when a provider errors, and tracks health so a bad provider is skipped and tried again later. Build one with `createProviderRouter(config)`, or use `createDefaultProviderRouter()`, which turns on every free-tier provider that has an API key set. Call `router.generateText(prompt)` (it returns `RateLimited` when nobody can answer), `generateConversation`, or `toLanguageModel()` to hand the router to the AI SDK. `getHealthStatus()`, `getAvailableProviders()` and `resetProviderHealth(name)` let you look and reset.

## Cost, pricing and budgets

All of this lives in `@arki/ai/cost`. Prices are USD per 1,000 tokens.

- `LLM_PRICING`: the list prices by model id. `getModelPricing(model)` reads one, `hasKnownPricing(model)` says if the model is listed, `getSupportedModels()` lists all ids and `getModelsByProvider(prefix)` filters them.
- `DEFAULT_PRICING`: the rate for an unknown hosted model (0.01 in, 0.03 out per 1k). It is high on purpose, so an unknown model is never undercharged.
- `PRICE_BASES`: how a price was found: `local`, `list-price` or `default-rate`.
- `LOCAL_PROVIDERS` and `isLocalProvider(provider)`: providers that run on your machine (`ollama`, also `ollama.chat`). A call there costs 0.
- `estimateTokens(text)` (about 4 characters per token) and `estimateTokensFromWords(count)` (about 1.3 tokens per word): rough counts for English, for planning. Use a real tokenizer when you need exact numbers.
- `createCostEstimator()` builds a `CostEstimator`; `costEstimator` is a ready instance. It prices LLM calls and embeddings and sums estimates.
- `createBudgetManager(kv, options)` builds a `BudgetManager` over an `@arki/kv` store. It tracks spend per user per period, `checkBudget` returns `BudgetExceeded` before a call, and `recordSpend` books the cost after. `DEFAULT_BUDGET_LIMITS` is 1 USD per hour, 10 per day, 50 per week, 100 per month. Override them for your app.
- `createCostCircuitBreaker(config)` stops all calls once failures or cost pass a threshold, then lets a few through to test recovery. `createUserCircuitBreakerManager(config)` builds a `UserCircuitBreakerManager`, which keeps one breaker per user (`getForUser`, `getOpenCircuits`, `resetUser`). `DEFAULT_CIRCUIT_CONFIG` opens after 3 failures or 10 USD, and needs 2 successes to close after 60 seconds.

## Safety

Import from `@arki/ai/safety`. Run these on input before it reaches a model, and on output before it reaches a user.

- `createInputSanitizer(config)` builds a `BaseInputSanitizer`. It limits length, strips dangerous characters, normalises white space, redacts PII and detects prompt injection. The result is one of `SANITIZATION_RESULTS`: `clean`, `sanitized` or `blocked`. Issue types start from `BASE_ISSUE_TYPES`; extend them for your app. `DEFAULT_SANITIZER_CONFIG` holds the defaults (10,000 characters, every check on).
- `createPromptInjectionDetector(patterns?, replaceDefaults?)` builds a `PromptInjectionDetector`. `detect(text)` returns issues. `DEFAULT_INJECTION_PATTERNS` covers persona changes, known jailbreaks, safety bypass, privilege escalation and system prompt extraction.
- `createPIIRedactor(patterns?, replaceDefaults?)` builds a `PIIRedactor`. `redact(text)` swaps matches for tags such as `[EMAIL REDACTED]`. `DEFAULT_PII_PATTERNS` covers common PII types.
- `createOutputContentFilter(config)` builds an `OutputContentFilter`. You give it categories with patterns and thresholds. `analyze(text)` returns a rating from `CONTENT_RATINGS` (`safe`, `needs_review`, `blocked`) and suggested replacements. `DEFAULT_OUTPUT_FILTER_CONFIG.blockingMultiplier` (2) sets how far past a threshold counts as blocked.
- `detectionPatternSchema` and `piiPatternSchema`: Zod schemas for one custom pattern (a real `RegExp` plus a description, and a replacement for PII).

## Semantic search service

`SemanticSearchService` ties an embedding model, a vector index and a cache into one search call. `search(options)` returns results or an `EmbedFailure`. `indexDocuments` adds documents. `getSuggestions(prefix)` gives popular queries. `getMetrics()` shows hits and timings. Call `destroy()` when done.

- `createVectorSearchProvider(config)`: builds the vector index. `type: 'qdrant'` talks to Qdrant, `type: 'mock'` gives a `MockVectorProvider`.
- `MockVectorProvider`: an in-memory index that holds documents with embeddings. Use it in tests and local demos, never in production.
- `InMemorySearchCache`: a cache inside the process. It forgets on restart.
- `RedisSearchCache(client, ttlSeconds)`: a cache over a Redis client you pass in. Entries are JSON with a time to live (default 3600 s).
- `SearchAnalyticsCollector`: records each query. It answers `getPopularSearches`, `getQueryFrequency`, `getUserHistory` and `getMetrics`, and can `export` and `import` its data.
- `searchAnalyticsExportSchema`: the Zod schema for what `SearchAnalyticsCollector.export` returns and `import` accepts, also after a JSON round trip.
- `TOMBSTONE_INSERT_CHUNK` (5000) and `TOMBSTONE_DELETE_CHUNK` (10,000): how many rows the Drizzle outbox writes per statement. They keep one statement under the database limit on bind parameters (65,535 on Postgres, 32,766 on SQLite). They are for `@arki/ai/drizzle`, not for app code.

## Task functions

Small functions that ask a model one narrow question and check the answer with a schema. Each takes an optional provider and defaults to `createLLMProvider` with a low temperature.

- `classifyIntent(message)`: tells a RAG pipeline how to route a user message.
- `classifyConnection(textA, textB)`: names the link between two passages, with an explanation and a confidence score.
- `nameCluster(sampleTitles, provider, existingName?)`: gives a cluster of documents a short name, with type and depth.
- `analyzeContent(text, title, wordCount)`: summaries, takeaways, entities and metadata. It cuts the text at 40,000 characters.
- `analyzeEpisode(...)` and `validateTranscript(transcript, maximum)`: analyse a diarized podcast transcript in chunks. `validateTranscript` rejects a transcript that is too long. A speaker name is only accepted when the speaker says it about themselves.
- `answerEpisodeQuestion(input, transcript, model)`: answers a question about an episode from a bounded set of passages (`askPassages`), and cites at most 4 of them. `askCitationLabels(text, sources)` swaps reference ids the model echoed for real source times.
- `arrangeQueue(input, evidence, model)`: suggests a listening order. `validateQueueOrder(ids, proposed)` throws unless the suggestion holds every queued id exactly once.
- `suggestPipIntervals(transcript, anchor, model)`: picks real timed sentence windows near a capture point. `pipIntervalCandidates` lists the windows (at most 100); the model only ranks them.
- `selectPodHopMoments(transcript, model)` plans a route of moments from a transcript, grounded in quoted evidence. `hopSelectionSchema` checks the plan. `synthesizePodHopNarration(textFile, outputFile, language)` speaks a narration with the macOS `say` command, using `podHopVoices` (en, ro, es, de).
- `passageSchema`: the shape of one transcript passage used by the ask flow.
- `transcribeDiarizedAudio(bytes, { deepgramKey, transcriptionModel? }, signal?)`: sends audio to Deepgram (default model `nova-3`) and returns a `DiarizedTranscript` of timed, speaker-labelled segments. It throws on empty audio or an HTTP error (`@arki/ai/transcription`).

The podcast functions (`pipIntervalCandidates`, `selectPodHopMoments`, `synthesizePodHopNarration`, `podHopVoices`, `arrangeQueue`) were written for one product and need a local Ollama model.

## Runtime streams and tools

`@arki/ai/runtime` moves `RuntimeEvent`s from an agent run to a browser.

- `toRuntimeEventStreamResponse(events, init?)`: on the server, sends events as Server-Sent Events, one JSON `data:` frame each, ended by `[DONE]`.
- `readRuntimeEventStream(responseOrBody)`: on the client, turns that body back into events. It skips frames it cannot parse.
- `fetchRuntimeEventStream(url, init?)`: fetches an endpoint and streams its events. A failed HTTP status yields one `run:error` event.
- `initialRuntimeUiState` and `runtimeEventReducer(state, event)`: a pure reducer that folds each event into UI state (text, tool calls that go running then done or failed, usage, error). `useRuntimeStream` uses it; use it directly with any UI library.
- `toAiSdkToolSet(tools, onFailure?)` and `toMastraTools(tools, onFailure?)`: turn neutral `AgentTool`s into an AI SDK tool set or Mastra tools. `onFailure` hears each tool call that returned an `@arki/failure`. `createMastraRuntime(options)` builds an `AgentRuntime` on Mastra (`@arki/ai/mastra`).

## Validation and error helpers

- `validateInputAsync(schema, input, message?)`: validates with any Standard Schema. It throws a validation error that lists each field and message.
- `chatMessageSchema`, `documentSchema`, `documentsSchema`, `generationOptionsSchema`, `qdrantConfigSchema` and `vectorProviderConfigSchema`: Zod schemas for chat messages, documents to index, generation options, and the Qdrant or vector provider config. Use them to check request bodies.
- `PROVIDER_FAILURES`: every failure a provider call returns. `isProviderFailure(value)` is true for one of them.
- `RUNTIME_FAILURES`: every failure a `run:error` event can carry. The SSE transport keeps their code and data across the wire.
- `CIRCUIT_OPEN_REASONS`: why `CircuitOpen` refused a call: `open` (already open) or `cost_threshold` (this call would cross the threshold).
- `isAIError(error)` is true for an `AIError`. `hasErrorMessage(error)` is true for anything with a string `message`. `getErrorMessage(error)` reads a message from any thrown value without throwing.

## Markdown rendering (React)

`@arki/ai/react/md` re-exports the markdown pieces used by `AIChat`, so apps share one copy.

- `ReactMarkdown` and `remarkGfm`: the standard renderer and the GitHub table and task-list plugin.
- `Streamdown`, `Block`, `StreamdownContext`, `parseMarkdownIntoBlocks`, `defaultRemarkPlugins` and `defaultRehypePlugins`: Vercel's renderer for text that is still streaming. It splits the text into `Block`s so only the last block re-renders. The context and plugin lists let you build a custom renderer with the same rules.
- `Typewriter` (from `@arki/ai/react`): types out a list of texts one after another, with a cursor.
