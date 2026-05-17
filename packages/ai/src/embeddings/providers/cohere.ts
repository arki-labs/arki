/**
 * Cohere embedding provider.
 *
 * Backed by `@ai-sdk/cohere`. Wraps the AI SDK v6 embedding model through
 * `AiSdkEmbeddingProvider` so caching/batching are shared with all other
 * AI-SDK providers.
 *
 * Default model: `embed-v4.0` (1536-d, 128K ctx — the longest context window
 * of any major 2026 cloud embedding model per the STATE-OF-THE-ART survey).
 * Supports MRL truncation via the `dimensions` config.
 *
 * Reranking is exposed as a separate concept under `embeddings/rerankers/cohere.ts`.
 */

import { createCohere } from '@ai-sdk/cohere';

import { AiSdkEmbeddingProvider } from './ai-sdk';
import type { BaseEmbeddingConfig } from '../base';

export type CohereEmbeddingConfig = BaseEmbeddingConfig & {
  apiKey?: string;
  /** e.g. `embed-v4.0`, `embed-english-v3.0`, `embed-multilingual-v3.0`. */
  model?: string;
  /** Output dimensions (Matryoshka). embed-v4.0 supports 256–1536. */
  dimensions?: number;
  baseURL?: string;
};

const DEFAULT_MODEL = 'embed-v4.0';
const DEFAULT_DIMS = 1536;

export class CohereEmbeddingProvider extends AiSdkEmbeddingProvider {
  constructor(config: CohereEmbeddingConfig = {}) {
    const cohere = createCohere({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    super({
      ...config,
      label: 'cohere',
      model: cohere.embedding(config.model ?? DEFAULT_MODEL),
      dimensions: config.dimensions ?? DEFAULT_DIMS,
    });
  }
}
