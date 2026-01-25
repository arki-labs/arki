/**
 * @arki/ai - Comprehensive AI, RAG, and Vector Search Library
 * Provides reusable AI infrastructure for all Arki projects
 */

// Core types and interfaces
export type {
  EmbeddingProvider,
  VectorSearchProvider,
  VectorSearchResult,
  SearchMode,
  SearchResult,
  SearchOptions as SearchOptionsType,
  AIServiceConfig as AIServiceConfigType,
  StreamingHandler,
  RAGConfig,
  DocumentChunk,
  CacheEntry,
  AnalyticsEvent,
} from './types';

// Error handling
export {
  AIError,
  EmbeddingError,
  VectorSearchError,
  GenerationError,
  ValidationError,
  RateLimitError,
  ConfigurationError,
  isAIError,
  hasErrorMessage,
  getErrorMessage,
} from './errors';

// Input validation
export {
  // Schemas
  openaiEmbeddingConfigSchema,
  mockEmbeddingConfigSchema,
  qdrantConfigSchema,
  embeddingConfigSchema,
  vectorProviderConfigSchema,
  searchOptionsSchema,
  aiServiceConfigSchema,
  generationOptionsSchema,
  documentSchema,
  documentsSchema,
  chatMessageSchema,
  // Types
  type OpenAIEmbeddingConfig,
  type MockEmbeddingConfig,
  type QdrantConfig,
  type EmbeddingConfig,
  type VectorProviderConfig,
  type SearchOptions,
  type AIServiceConfig,
  type GenerationOptions,
  type Document,
  type ChatMessage,
  // Functions
  validateInput,
  validateInputAsync,
} from './validation';

// Embedding providers and interfaces
export {
  OpenAIEmbeddingProvider,
  MockEmbeddingProvider,
  createEmbeddingProvider,
  createEmbeddingProviderFromEnv,
  type EmbeddingProviderType,
  type EmbeddingProviderConfig,
} from './embeddings';

// Vector search providers and interfaces
export {
  QdrantVectorProvider,
  MockVectorProvider,
  createVectorSearchProvider,
  createVectorSearchProviderFromEnv,
  type VectorProviderType,
  type VectorSearchConfig,
  type QdrantSearchFilter,
} from './vector-search';

// Semantic search service and utilities
export {
  SemanticSearchService,
  SearchAnalyticsCollector,
  InMemorySearchCache,
  RedisSearchCache,
  type SemanticSearchConfig,
  type KeywordSearchProvider,
  type SearchAnalytics,
  type SearchMetrics,
  type SearchCache,
} from './semantic-search';

// AI service utilities and providers
export {
  // OpenAI and Anthropic services
  OpenAIService,
  type OpenAIServiceConfig,
  type StreamOptions,
  AnthropicService,
  type AnthropicServiceConfig,
  // New LLM provider services
  GroqService,
  createGroqService,
  type GroqServiceConfig,
  GoogleService,
  createGoogleService,
  type GoogleServiceConfig,
  MistralService,
  createMistralService,
  type MistralServiceConfig,
  OpenRouterService,
  createOpenRouterService,
  type OpenRouterServiceConfig,
  // Provider router for multi-provider rotation and fallback
  ProviderRouter,
  createProviderRouter,
  createDefaultProviderRouter,
  type ProviderRouterConfig,
  // Common LLM types
  type LLMProvider,
  type ProviderConfig,
  type ProviderHealth,
  type ProviderResult,
  type Message,
  type GenerateOptions,
} from './ai-service';

// Environment configuration
export { env } from './env';

// Flow orchestration utilities
export {
  Flow,
  FlowError,
  createFlow,
  type FlowConfig,
  type FlowEvent,
  type FlowNode,
} from './orchestration';
