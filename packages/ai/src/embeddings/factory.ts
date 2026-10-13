/**
 * Factory for creating embedding providers.
 *
 * Discriminated-union dispatch over `EmbeddingProviderConfig.type` returns a
 * concrete `EmbeddingProvider`. Provider-specific configs are typed by the
 * union — so `type: 'cohere'` enforces a `CohereEmbeddingConfig` shape, etc.
 *
 * Bedrock is async-only because its SDK is heavy and lazy-imported; use
 * `createBedrockEmbeddingProvider` directly when you need it.
 *
 * Env-based factory (`createEmbeddingProviderFromEnv`) covers the most common
 * production wiring — choose a provider type via `EMBEDDING_PROVIDER` and
 * supply credentials via the provider's API-key env var.
 */

import type { EmbeddingProvider } from '../types';
import type { BedrockEmbeddingConfig } from './providers/bedrock';
import type { CohereEmbeddingConfig } from './providers/cohere';
import type { GoogleEmbeddingConfig } from './providers/google';
import type { JinaEmbeddingConfig } from './providers/jina';
import type { MistralEmbeddingConfig } from './providers/mistral';
import type { MixedbreadEmbeddingConfig } from './providers/mixedbread';
import type { MockEmbeddingConfig } from './providers/mock';
import type { NebiusEmbeddingConfig } from './providers/nebius';
import type { OllamaEmbeddingConfig } from './providers/ollama';
import type { OpenAIEmbeddingConfig } from './providers/openai';
import type { OpenAICompatibleEmbeddingConfig } from './providers/openai-compatible';
import type { TransformersJsEmbeddingConfig } from './providers/transformers-js';
import type { VoyageEmbeddingConfig } from './providers/voyage';
import { debugEmbeddings } from '../debug.ts';
import { env } from '../env';
import { ConfigurationError } from '../errors';
import { createBedrockEmbeddingProvider } from './providers/bedrock';
import { CohereEmbeddingProvider } from './providers/cohere';
import { GoogleEmbeddingProvider } from './providers/google';
import { JinaEmbeddingProvider } from './providers/jina';
import { MistralEmbeddingProvider } from './providers/mistral';
import { MixedbreadEmbeddingProvider } from './providers/mixedbread';
import { MockEmbeddingProvider } from './providers/mock';
import { NebiusEmbeddingProvider } from './providers/nebius';
import { OllamaEmbeddingProvider } from './providers/ollama';
import { OpenAIEmbeddingProvider } from './providers/openai';
import { OpenAICompatibleEmbeddingProvider } from './providers/openai-compatible';
import { TransformersJsEmbeddingProvider } from './providers/transformers-js';
import { VoyageEmbeddingProvider } from './providers/voyage';

export type EmbeddingProviderType =
  | 'openai'
  | 'openai-compatible'
  | 'cohere'
  | 'mistral'
  | 'google'
  | 'bedrock'
  | 'ollama'
  | 'voyage'
  | 'jina'
  | 'nebius'
  | 'mixedbread'
  | 'transformers-js'
  | 'mock';

export type EmbeddingProviderConfig =
  | { type: 'openai'; config?: OpenAIEmbeddingConfig }
  | { type: 'openai-compatible'; config: OpenAICompatibleEmbeddingConfig }
  | { type: 'cohere'; config?: CohereEmbeddingConfig }
  | { type: 'mistral'; config?: MistralEmbeddingConfig }
  | { type: 'google'; config?: GoogleEmbeddingConfig }
  | { type: 'bedrock'; config?: BedrockEmbeddingConfig }
  | { type: 'ollama'; config?: OllamaEmbeddingConfig }
  | { type: 'voyage'; config?: VoyageEmbeddingConfig }
  | { type: 'jina'; config?: JinaEmbeddingConfig }
  | { type: 'nebius'; config?: NebiusEmbeddingConfig }
  | { type: 'mixedbread'; config?: MixedbreadEmbeddingConfig }
  | { type: 'transformers-js'; config?: TransformersJsEmbeddingConfig }
  | { type: 'mock'; config?: MockEmbeddingConfig };

/**
 * Create an embedding provider synchronously. Bedrock is not supported here
 * because it lazy-imports its SDK — use `createEmbeddingProviderAsync` or
 * `createBedrockEmbeddingProvider` directly.
 */
export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  debugEmbeddings.debug('[Factory] creating embedding provider (type: {type})', { type: config.type });

  switch (config.type) {
    case 'openai': {
      return new OpenAIEmbeddingProvider(config.config);
    }
    case 'openai-compatible': {
      return new OpenAICompatibleEmbeddingProvider(config.config);
    }
    case 'cohere': {
      return new CohereEmbeddingProvider(config.config);
    }
    case 'mistral': {
      return new MistralEmbeddingProvider(config.config);
    }
    case 'google': {
      return new GoogleEmbeddingProvider(config.config);
    }
    case 'ollama': {
      return new OllamaEmbeddingProvider(config.config);
    }
    case 'voyage': {
      return new VoyageEmbeddingProvider(config.config);
    }
    case 'jina': {
      return new JinaEmbeddingProvider(config.config);
    }
    case 'nebius': {
      return new NebiusEmbeddingProvider(config.config);
    }
    case 'mixedbread': {
      return new MixedbreadEmbeddingProvider(config.config);
    }
    case 'transformers-js': {
      return new TransformersJsEmbeddingProvider(config.config);
    }
    case 'mock': {
      return new MockEmbeddingProvider(config.config);
    }
    case 'bedrock': {
      throw new ConfigurationError(
        'Bedrock provider requires async construction. Call createEmbeddingProviderAsync({ type: "bedrock", ... }) or createBedrockEmbeddingProvider() directly.',
      );
    }
    default: {
      const _exhaustive: never = config;
      throw new ConfigurationError(`Unknown embedding provider type: ${(_exhaustive as { type: string }).type}`);
    }
  }
}

/**
 * Async variant — supports every provider type, including Bedrock.
 */
export async function createEmbeddingProviderAsync(config: EmbeddingProviderConfig): Promise<EmbeddingProvider> {
  if (config.type === 'bedrock') {
    return createBedrockEmbeddingProvider(config.config);
  }
  return createEmbeddingProvider(config);
}

/**
 * Wire a default provider from environment variables. Each provider reads
 * its own API key env var; `EMBEDDING_PROVIDER` selects which one.
 */
export function createEmbeddingProviderFromEnv(): EmbeddingProvider {
  const providerType = env.EMBEDDING_PROVIDER;
  debugEmbeddings.debug('[Factory] creating from env (type: {type})', { type: providerType });

  switch (providerType) {
    case 'openai': {
      return new OpenAIEmbeddingProvider({
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_EMBEDDING_MODEL,
      });
    }
    case 'cohere': {
      return new CohereEmbeddingProvider({
        apiKey: env.COHERE_API_KEY,
        model: env.COHERE_EMBEDDING_MODEL,
      });
    }
    case 'mistral': {
      return new MistralEmbeddingProvider({
        apiKey: env.MISTRAL_API_KEY,
        model: env.MISTRAL_EMBEDDING_MODEL,
      });
    }
    case 'google': {
      return new GoogleEmbeddingProvider({
        apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
        model: env.GOOGLE_EMBEDDING_MODEL,
      });
    }
    case 'ollama': {
      return new OllamaEmbeddingProvider({
        baseURL: env.OLLAMA_BASE_URL,
        model: env.OLLAMA_EMBEDDING_MODEL,
      });
    }
    case 'voyage': {
      return new VoyageEmbeddingProvider({
        apiKey: env.VOYAGE_API_KEY,
        model: env.VOYAGE_EMBEDDING_MODEL,
      });
    }
    case 'jina': {
      return new JinaEmbeddingProvider({
        apiKey: env.JINA_API_KEY,
        model: env.JINA_EMBEDDING_MODEL,
      });
    }
    case 'nebius': {
      return new NebiusEmbeddingProvider({
        apiKey: env.NEBIUS_API_KEY,
        model: env.NEBIUS_EMBEDDING_MODEL,
        dimensions: env.NEBIUS_EMBEDDING_DIMENSIONS,
        baseURL: env.NEBIUS_BASE_URL,
      });
    }
    case 'mixedbread': {
      return new MixedbreadEmbeddingProvider({
        apiKey: env.MXBAI_API_KEY,
        model: env.MXBAI_EMBEDDING_MODEL,
      });
    }
    case 'openai-compatible': {
      const baseURL = env.OPENAI_COMPATIBLE_BASE_URL;
      const model = env.OPENAI_COMPATIBLE_MODEL;
      const dimensions = env.OPENAI_COMPATIBLE_DIMENSIONS;
      if (!baseURL || !model || !dimensions) {
        throw new ConfigurationError(
          'openai-compatible provider requires OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_MODEL, and OPENAI_COMPATIBLE_DIMENSIONS.',
        );
      }
      return new OpenAICompatibleEmbeddingProvider({
        baseURL,
        model,
        dimensions,
        apiKey: env.OPENAI_COMPATIBLE_API_KEY,
      });
    }
    case 'transformers-js': {
      return new TransformersJsEmbeddingProvider({
        model: env.TRANSFORMERS_JS_MODEL,
      });
    }
    case 'mock': {
      return new MockEmbeddingProvider();
    }
    default: {
      throw new ConfigurationError(
        `Unknown EMBEDDING_PROVIDER value: ${String(providerType)}. Set to one of: openai, openai-compatible, cohere, mistral, google, ollama, voyage, jina, nebius, mixedbread, transformers-js, mock. (Bedrock requires async construction — call createBedrockEmbeddingProvider() directly.)`,
      );
    }
  }
}
