/**
 * Text embeddings — providers, factory, and rerankers.
 *
 * Recommendation grid (from STATE-OF-THE-ART.md):
 *   - Privacy-max    → ollama (Qwen3-Embedding-4B/8B) or openai-compatible (TEI on RTX 4090)
 *   - Cost-min       → openai (text-embedding-3-small Batch) or ollama (Arctic-Embed-M)
 *   - Balanced       → voyage (voyage-4 with 200M free tier) or cohere (embed-v4 128K ctx)
 *   - Latency-crit   → openai/cohere query embed + qdrant + tei reranker (mxbai-large-v2)
 *   - On-device      → transformers-js (Nomic-Embed-Text-v1.5 in browser / Node)
 *
 * Each provider exports its config type for explicit instantiation; use the
 * `createEmbeddingProvider` discriminated-union factory for runtime dispatch
 * or `createEmbeddingProviderFromEnv` for env-driven wiring.
 */

// Provider classes & their configs
export {
  OpenAIEmbeddingProvider,
  type OpenAIEmbeddingConfig,
} from './providers/openai';
export {
  OpenAICompatibleEmbeddingProvider,
  type OpenAICompatibleEmbeddingConfig,
} from './providers/openai-compatible';
export {
  CohereEmbeddingProvider,
  type CohereEmbeddingConfig,
} from './providers/cohere';
export {
  MistralEmbeddingProvider,
  type MistralEmbeddingConfig,
} from './providers/mistral';
export {
  GoogleEmbeddingProvider,
  type GoogleEmbeddingConfig,
} from './providers/google';
export {
  OllamaEmbeddingProvider,
  type OllamaEmbeddingConfig,
} from './providers/ollama';
export {
  VoyageEmbeddingProvider,
  type VoyageEmbeddingConfig,
} from './providers/voyage';
export {
  JinaEmbeddingProvider,
  type JinaEmbeddingConfig,
} from './providers/jina';
export {
  NebiusEmbeddingProvider,
  type NebiusEmbeddingConfig,
} from './providers/nebius';
export {
  MixedbreadEmbeddingProvider,
  type MixedbreadEmbeddingConfig,
} from './providers/mixedbread';
export {
  TransformersJsEmbeddingProvider,
  type TransformersJsEmbeddingConfig,
} from './providers/transformers-js';
export {
  createBedrockEmbeddingProvider,
  type BedrockEmbeddingConfig,
} from './providers/bedrock';
export {
  MockEmbeddingProvider,
  type MockEmbeddingConfig,
  TEST_EMBEDDINGS,
} from './providers/mock';

// Shared base — exported so apps can build custom providers reusing the
// caching/batching infrastructure.
export {
  BaseEmbeddingProvider,
  type BaseEmbeddingConfig,
} from './base';
export {
  AiSdkEmbeddingProvider,
  type AiSdkEmbeddingConfig,
} from './providers/ai-sdk';

// Factory
export {
  createEmbeddingProvider,
  createEmbeddingProviderAsync,
  createEmbeddingProviderFromEnv,
  type EmbeddingProviderType,
  type EmbeddingProviderConfig,
} from './factory';

// Core type
export type { EmbeddingProvider } from '../types';

// Rerankers (siblings of embeddings)
export * as rerankers from './rerankers';
