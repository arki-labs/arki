/**
 * AiSdkEmbeddingProvider — adapts any Vercel AI SDK v6 embedding model
 * (`EmbeddingModelV2`) into our internal `EmbeddingProvider` shape via
 * `embedMany()`.
 *
 * This is the integration point for `@ai-sdk/cohere`, `@ai-sdk/mistral`,
 * `@ai-sdk/google`, `@ai-sdk/amazon-bedrock`, `ai-sdk-ollama`, and any
 * future AI SDK provider that exposes `.embedding(modelId)`.
 *
 * Per-provider thin wrappers (cohere.ts, mistral.ts, etc.) handle SDK
 * instantiation and pass the resulting model into this class.
 */

import { embedMany } from 'ai';
import type { EmbeddingModel } from 'ai';

import { BaseEmbeddingProvider } from '../base';
import type { BaseEmbeddingConfig } from '../base';
import { EmbeddingError, getErrorMessage } from '../../errors';

export type AiSdkEmbeddingConfig = BaseEmbeddingConfig & {
  /** The AI SDK embedding model instance (e.g. `cohere.embedding('embed-v4.0')`). */
  model: EmbeddingModel;
  /** Reported embedding dimension. Should match the model. */
  dimensions: number;
  /** Optional logger label (defaults to `ai-sdk`). */
  label?: string;
};

export class AiSdkEmbeddingProvider extends BaseEmbeddingProvider {
  protected readonly providerLabel: string;
  private readonly model: EmbeddingModel;
  private readonly dimensions: number;

  constructor(config: AiSdkEmbeddingConfig) {
    super(config);
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.providerLabel = config.label ?? 'ai-sdk';
  }

  getDimensions(): number {
    return this.dimensions;
  }

  protected async fetchEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      const { embeddings } = await embedMany({
        model: this.model,
        values: texts,
      });
      return embeddings;
    } catch (error) {
      throw new EmbeddingError(
        `[${this.providerLabel}] embedMany failed: ${getErrorMessage(error)}`,
        error,
      );
    }
  }
}
