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
import { createQdrantProvider, createEmbeddingProvider } from '@arki/ai';

const embedder = createEmbeddingProvider({ type: 'openai' });
const vectorStore = createQdrantProvider(
  {
    url: 'http://localhost:6333',
    collectionName: 'documents',
  },
  embedder
);

// Index documents
await vectorStore.indexDocument('doc1', 'This is a test document');

// Search
const results = await vectorStore.searchSimilar('test query', 10);
```

### Semantic Search Service

```typescript
import { SemanticSearchService, createVectorProvider, createEmbeddingProvider } from '@arki/ai';

const embedder = createEmbeddingProvider({ type: 'openai' });
const vectorProvider = createVectorProvider({
  type: 'qdrant',
  embeddingProvider: embedder,
  config: { url: 'http://localhost:6333', collectionName: 'docs' }
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
import { OpenAIService, StructuredGenerator } from '@arki/ai';

const ai = new OpenAIService({ model: 'gpt-4o-mini' });
const generator = new StructuredGenerator(ai);

// Generate structured data
const summary = await generator.generateSummary('Long text to summarize...');

// Stream responses
for await (const chunk of ai.streamText('Tell me a story')) {
  console.log(chunk);
}
```

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
- `generateStructuredData(prompt, schema)`: Generate structured data
- `generateText(prompt)`: Generate text
- `streamText(prompt)`: Stream text generation
- `generateConversation(messages)`: Generate conversation response

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

const prompt = PromptBuilder
  .fromTemplate(PromptTemplates.summarize)
  .setVariable('contentType', 'article')
  .setVariable('content', articleText)
  .setVariable('focus', 'key takeaways')
  .setVariable('maxLength', '200')
  .build();

const summary = await ai.generateText(prompt.prompt, {
  systemPrompt: prompt.systemPrompt
});
```

## License

MIT