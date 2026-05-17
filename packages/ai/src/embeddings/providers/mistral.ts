/**
 * Mistral embedding provider.
 *
 * Backed by `@ai-sdk/mistral`. Default model `mistral-embed` (1024-d, 8K ctx,
 * EU-native French-jurisdiction provider per the SOTA privacy matrix).
 * For code-specific retrieval use `codestral-embed-2505` ($0.15/M, 8K ctx).
 */

import { createMistral } from '@ai-sdk/mistral';

import { AiSdkEmbeddingProvider } from './ai-sdk';
import type { BaseEmbeddingConfig } from '../base';

export type MistralEmbeddingConfig = BaseEmbeddingConfig & {
  apiKey?: string;
  /** e.g. `mistral-embed`, `codestral-embed-2505`. */
  model?: string;
  baseURL?: string;
  /** Dimensions reported back to consumers. Mistral default is 1024. */
  dimensions?: number;
};

const DEFAULT_MODEL = 'mistral-embed';
const DEFAULT_DIMS = 1024;

export class MistralEmbeddingProvider extends AiSdkEmbeddingProvider {
  constructor(config: MistralEmbeddingConfig = {}) {
    const mistral = createMistral({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    super({
      ...config,
      label: 'mistral',
      model: mistral.embedding(config.model ?? DEFAULT_MODEL),
      dimensions: config.dimensions ?? DEFAULT_DIMS,
    });
  }
}
