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
  type SystemPart,
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
  type ResolvedLanguageModel,
  // Common LLM types
  type LLMProvider,
  type ProviderConfig,
  type ProviderHealth,
  type ProviderResult,
  type Message,
  type GenerateOptions,
  // Provider-agnostic factory and interface
  createLLMProvider,
  type LLMProviderConfig,
  type StructuredLLMProvider,
} from './ai-service';

// Environment configuration
export { env } from './env';

// Higher-level AI capabilities (provider-agnostic, schema-validated)
export {
  classifyIntent,
  type ClassifiedIntent,
  type IntentType,
  nameCluster,
  type ClusterName,
  type ClusterNamingContext,
  type ClusterType,
  analyzeContent,
  ContentAnalysisSchema,
  type ContentAnalysis,
  type ContentCategory,
  type ContentType,
  type EntityType,
  type ImportanceLevel,
  classifyConnection,
  type ConnectionClassification,
  type ConnectionType,
} from './capabilities';

// Flow orchestration utilities
export {
  Flow,
  FlowError,
  createFlow,
  type FlowConfig,
  type FlowEvent,
  type FlowNode,
} from './orchestration';

// Cost management utilities
export {
  // Types
  type BudgetCheckResult,
  type BudgetConfig,
  type BudgetLimits,
  type BudgetPeriod,
  type CircuitBreakerResult,
  type CircuitBreakerState,
  type CircuitState,
  type CostCircuitConfig,
  type CostEstimate,
  type ModelPricing,
  type KVStore,
  type SpendMetadata,
  type SpendRecord,
  type StandardBudgetPeriod,
  // Constants
  BUDGET_PERIODS,
  CIRCUIT_STATES,
  LLM_PRICING,
  DEFAULT_PRICING,
  DEFAULT_BUDGET_LIMITS,
  DEFAULT_CIRCUIT_CONFIG,
  BUDGET_PERIOD_DURATIONS,
  // Classes
  CostEstimator,
  BudgetManager,
  CostCircuitBreaker,
  CircuitBreakerError,
  UserCircuitBreakerManager,
  // Instances
  costEstimator,
  // Factory functions
  createCostEstimator,
  createBudgetManager,
  createCostCircuitBreaker,
  createUserCircuitBreakerManager,
  // Utility functions
  getModelPricing,
  hasKnownPricing,
  calculateLLMCost,
  estimateTokens,
  estimateTokensFromWords,
  getSupportedModels,
  getModelsByProvider,
} from './cost';
