# @arki/ai

Comprehensive AI, RAG, and Vector Search library for Arki projects.

## Features

- 🔍 **Vector Search**: Production-ready vector search with Qdrant, Pinecone (coming soon), and Weaviate (coming soon)
- 🧠 **Embeddings**: Multiple embedding providers (OpenAI, Cohere, Anthropic)
- 🔎 **Semantic Search**: Advanced search with caching, analytics, and hybrid modes
- 🤖 **AI Services**: Structured generation, streaming, and conversation APIs
- ⚛️ **React Components**: Ready-to-use AI chat, search, and streaming components
- 📊 **Analytics**: Built-in search and usage analytics
- 💾 **Caching**: Intelligent caching for improved performance

## Installation

```bash
pnpm add @arki/ai
```

## Quick Start

### Embedding Provider

```typescript
import { createEmbeddingProvider } from '@arki/ai';

const embedder = createEmbeddingProvider({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'text-embedding-3-small',
});

const embedding = await embedder.getEmbedding('Hello world');
```

### Vector Search

```typescript
import { createEmbeddingProvider, createQdrantProvider } from '@arki/ai';

const embedder = createEmbeddingProvider({ type: 'openai' });
const vectorStore = createQdrantProvider(
  {
    url: 'http://localhost:6333',
    collectionName: 'documents',
  },
  embedder,
);

// Index documents
await vectorStore.indexDocument('doc1', 'This is a test document');

// Search
const results = await vectorStore.searchSimilar('test query', 10);
```

### Semantic Search Service

```typescript
import { createEmbeddingProvider, createVectorProvider, SemanticSearchService } from '@arki/ai';

const embedder = createEmbeddingProvider({ type: 'openai' });
const vectorProvider = createVectorProvider({
  type: 'qdrant',
  embeddingProvider: embedder,
  config: { url: 'http://localhost:6333', collectionName: 'docs' },
});

const searchService = new SemanticSearchService({
  vectorProvider,
  enableCache: true,
  cacheTTL: 3600,
});

const results = await searchService.search({
  query: 'machine learning',
  mode: 'hybrid',
  limit: 20,
});
```

### AI Generation

```typescript
import { createLLMProvider, OpenAIService, RateLimited, StructuredGenerator } from '@arki/ai';

const ai = new OpenAIService({ model: 'gpt-4o-mini' });
const generator = new StructuredGenerator(createLLMProvider());

// Generate structured data
const summary = await generator.generateSummary('Long text to summarize...');

// Stream responses: the call takes a rate-limit slot first, so check for RateLimited before iterating
const stream = await ai.streamText('Tell me a story');
if (RateLimited.is(stream)) return stream; // data: { retryAfterMs }
for await (const chunk of stream) {
  console.log(chunk);
}
```

### Orchestration (Flow)

```typescript
import { createFlow } from '@arki/ai';

type StoryState = {
  outline?: string;
  draft?: string;
  edited?: string;
  status: 'planning' | 'writing' | 'editing' | 'complete';
};

type CouncilContext = {
  planner: (input: string) => Promise<string>;
  writer: (input: string) => Promise<string>;
  editor: (input: string) => Promise<string>;
};

const flow = createFlow<StoryState, CouncilContext>({
  start: 'plan',
  nodes: {
    plan: {
      id: 'plan',
      run: async (state, ctx) => ({
        outline: await ctx.planner('Create an outline'),
        status: 'planning',
      }),
      next: 'write',
    },
    write: {
      id: 'write',
      run: async (state, ctx) => ({
        draft: await ctx.writer(state.outline ?? ''),
        status: 'writing',
      }),
      next: 'edit',
    },
    edit: {
      id: 'edit',
      run: async (state, ctx) => ({
        edited: await ctx.editor(state.draft ?? ''),
        status: 'complete',
      }),
      next: undefined,
    },
  },
});

const result = await flow.run(
  { status: 'planning' },
  {
    planner: async input => input,
    writer: async input => input,
    editor: async input => input,
  },
);
```

### Agents (AI SDK ToolLoopAgent)

`@arki/ai` re-exports the AI SDK agent utilities for tool-based loops.

```typescript
import { stepCountIs, tool, ToolLoopAgent } from '@arki/ai';
import { z } from '@arki/contracts';

const lookupTool = tool({
  description: 'Look up a story constraint by key',
  inputSchema: z.object({ key: z.string() }),
  execute: async ({ key }) => `value-for-${key}`,
});

const agent = new ToolLoopAgent({
  model: 'gpt-4o-mini',
  tools: { lookup: lookupTool },
  maxSteps: 4,
  stopWhen: stepCountIs(4),
});

const result = await agent.generate({
  prompt: 'Check the universe rule for "magic".',
});
```

### Agent runtime (`runToolLoop`)

`createAiSdkRuntime` runs a tool loop behind the framework-neutral `AgentRuntime` contract.
Define tools with `defineAgentTool`: `execute`'s input type comes from `inputSchema`, and its return
type comes from `output`.

```typescript
import { createAiSdkRuntime, defineAgentTool } from '@arki/ai';
import { z } from '@arki/contracts';

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
const runtime = createAiSdkRuntime({ model });
for await (const event of runtime.runToolLoop({ prompt: 'Oslo?', tools: [weather], signal: controller.signal })) {
  // run:start, text:delta, tool:start, tool:result, tool:failure, tool:error, run:finish
}
```

- **Cancel with `signal`.** After it aborts, the run starts no new model call or tool call. The
  model call in flight and every tool see the abort. The loop rejects with the signal's reason.
- **`inputSchema` is any Standard Schema that can emit JSON Schema** (wrap one that cannot with `withJsonSchema` from `@arki/schema`).
- **`output` is checked.** The runtime checks each result against `output` (Zod or any Standard
  Schema) before the model sees it. The model gets the parsed value. A mismatch fails that tool
  call with a `ToolOutputError` (code `TOOL_OUTPUT_ERROR`), which arrives as a `tool:error` event.
- **Return a failure for an expected outcome.** `execute` may return a failure from
  [`@arki/failure`](../failure), such as `CityNotFound({ city })`. The model gets
  `{ error: { code, message, remediation, data } }` as the tool result, so the remediation sentence
  can steer its next call. The `output` check is skipped, and the run emits
  `{ type: 'tool:failure', tool, failure }`. `runtimeEventReducer` marks that call `failed`. A thrown
  error is still a `tool:error`. Both runtimes (AI SDK and Mastra) behave the same.
- **Spans.** When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the AI SDK's own telemetry
  (`@ai-sdk/otel`) records one `step N` span per model step and one `execute_tool <name>` span per
  tool call. With no endpoint, or no OpenTelemetry SDK registered, nothing is recorded.

### React Components

```typescript
import { useAIChat, AIChat, useSemanticSearch, SearchInterface } from '@arki/ai';

function ChatComponent() {
  const chat = useAIChat({
    apiEndpoint: '/api/chat',
    streamResponse: true,
  });

  return (
    <AIChat
      messages={chat.messages}
      input={chat.input}
      isLoading={chat.isLoading}
      onInputChange={chat.setInput}
      onSubmit={(e) => {
        e.preventDefault();
        chat.sendMessage();
      }}
    />
  );
}

function SearchComponent() {
  const search = useSemanticSearch({
    apiEndpoint: '/api/search',
    mode: 'semantic',
    debounceMs: 300,
  });

  return (
    <SearchInterface
      query={search.query}
      results={search.results}
      suggestions={search.suggestions}
      isSearching={search.isSearching}
      onQueryChange={search.setQuery}
      onSearch={search.search}
    />
  );
}
```

## API Reference

### Embedding Providers

#### `createEmbeddingProvider(config)`

Creates an embedding provider instance.

**Config Options:**

- `type`: 'openai' | 'mock' | 'cohere' | 'anthropic'
- `apiKey`: API key for the provider
- `model`: Model to use for embeddings
- `batchSize`: Batch size for processing
- `cache`: Enable caching

### Vector Search

#### `createVectorProvider(config)`

Creates a vector search provider instance.

**Config Options:**

- `type`: 'qdrant' | 'mock' | 'pinecone' | 'weaviate'
- `embeddingProvider`: Embedding provider instance
- `config`: Provider-specific configuration

### Semantic Search

#### `SemanticSearchService`

Advanced search service with caching and analytics.

**Methods:**

- `search(options)`: Perform search
- `indexDocuments(documents)`: Index documents
- `getSuggestions(prefix)`: Get search suggestions
- `getMetrics()`: Get search analytics

### AI Services

#### `OpenAIService`

OpenAI integration using Vercel AI SDK.

**Methods:**

- `generateStructuredData(prompt, schema)`: Generate structured data. `schema` is any Standard Schema (zod, valibot, arktype). The model is shown its input JSON Schema; you get its output type back (transforms have run). A schema that cannot emit JSON Schema throws a `ConfigurationError` that names `withJsonSchema`.
- `generateText(prompt)`: Generate text
- `streamText(prompt)`: Stream text generation. Resolves to the chunk generator, or `RateLimited`.
- `generateConversation(messages)`: Generate conversation response

Each method checks a local rate limiter first. When it has no free slot, the method returns the `RateLimited` failure (code `ai.rate_limited`, status 429, data `{ retryAfterMs }`) instead of calling the model. It never throws for this. Provider faults still throw `GenerationError`.

#### `StructuredGenerator`

Helper for common generation tasks.

**Methods:**

- `generateSummary(text)`: Generate summary
- `answerQuestion(question, context)`: Answer questions
- `classifyText(text, categories)`: Classify text
- `extractEntities(text)`: Extract entities
- `analyzeSentiment(text)`: Analyze sentiment

### React Hooks

#### `useAIChat(options)`

Hook for AI chat functionality.

**Returns:**

- `messages`: Chat messages
- `input`: Current input
- `isLoading`: Loading state
- `sendMessage(text)`: Send message
- `clearMessages()`: Clear chat

#### `useSemanticSearch(options)`

Hook for semantic search.

**Returns:**

- `query`: Search query
- `results`: Search results
- `isSearching`: Loading state
- `search(query)`: Perform search
- `getSuggestions(prefix)`: Get suggestions

## Vector index (runtime, index, reconciler, Dot, Drizzle)

One env reader, local-first. The core never reads `process.env` — pass the map in.

```ts
import { createEmbedder, createEmbeddingRuntime, createVectorIndex, runVectorReconciliation } from '@arki/ai';

// EMBEDDING_PROVIDER → else Ollama (OLLAMA_BASE_URL / OLLAMA_HOST) → else OpenAI → else null.
const runtime = await createEmbeddingRuntime(process.env); // { provider, selection: { type, model, dimensions } } | null
const embedder = createEmbedder(runtime); // embedQuery(text, expectedDimensions?) → { vector, selection } | null

type Payload = { userId: string; kind: 'item' | 'chunk'; model: string; dimensions: number };
const index = runtime && createVectorIndex<Payload>(runtime, { collection: 'app_embeddings', payloadIndexes: ['userId', 'kind'], env: process.env });
// index.provider: Qdrant when QDRANT_URL is set (durable: true), the in-memory mock otherwise (durable: false)

// Cron: drain erasure tombstones (durable index only), migrate dimension mismatches, re-upsert current rows,
// then delete the points whose rows stopped being current while they were upserted.
const counts = await runVectorReconciliation({ durable: index.durable, targetDimensions, model, embedText, upsertPoint, deletePoints, tombstones, stores });
```

- `@arki/ai/dot` — `vectorIndex({ collection, payloadIndexes, env?, runtime?, provider? })` provides `embedder` and `vectorIndex` (`{ provider, durable }`, `provider` is `null` when nothing is configured). Resolved once at boot. Optional peer: `@arki/dot`.
- `@arki/ai/drizzle` — `createTombstoneTable<UserId>(schema, { name, idPrefix })` and `tombstoneOutbox(table)` → `write(tx, userId, pointIds)` (in the delete's transaction), `clear(db, pointIds)` (after a direct erasure), `store(db)` (the reconciler's `TombstoneStore`). Optional peers: `drizzle-orm`, `@arki/db`.

## Advanced Usage

### Custom Embedding Provider

```typescript
import { EmbeddingProvider } from '@arki/ai';

class CustomEmbeddingProvider implements EmbeddingProvider {
  async getEmbedding(text: string): Promise<number[]> {
    // Your implementation
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    // Batch implementation
  }

  getDimensions(): number {
    return 768; // Your model's dimensions
  }
}
```

### Custom Vector Provider

```typescript
import { VectorSearchProvider } from '@arki/ai';

class CustomVectorProvider implements VectorSearchProvider {
  async indexDocument(id, text, metadata) {
    // Your implementation
  }

  async searchSimilar(query, limit) {
    // Your implementation
  }
}
```

### Prompt Engineering

```typescript
import { PromptBuilder, PromptTemplates } from '@arki/ai';

const prompt = PromptBuilder.fromTemplate(PromptTemplates.summarize)
  .setVariable('contentType', 'article')
  .setVariable('content', articleText)
  .setVariable('focus', 'key takeaways')
  .setVariable('maxLength', '200')
  .build();

const summary = await ai.generateText(prompt.prompt, {
  systemPrompt: prompt.systemPrompt,
});
```

## License

MIT
