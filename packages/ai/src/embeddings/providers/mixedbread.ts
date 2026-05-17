/**
 * Mixedbread embedding provider.
 *
 * Backed by the official `@mixedbread-ai/sdk`. Default model
 * `mixedbread-ai/mxbai-embed-large-v1` (335M, Apache 2.0 open weights, binary
 * MRL native).
 *
 * Lazy-loaded — Mixedbread is a long-tail option per the SOTA survey;
 * dynamic import keeps it out of the hot path.
 *
 * Free tier may use submitted data for training (per SOTA C-12); use paid
 * tier in production.
 */

import { BaseEmbeddingProvider } from '../base';
import type { BaseEmbeddingConfig } from '../base';
import { EmbeddingError, getErrorMessage } from '../../errors';

export type MixedbreadEmbeddingConfig = BaseEmbeddingConfig & {
  apiKey?: string;
  /** e.g. `mixedbread-ai/mxbai-embed-large-v1`. */
  model?: string;
  dimensions?: number;
  /** Normalization for the returned vectors. Default: `unit`. */
  normalized?: boolean;
};

const DEFAULT_MODEL = 'mixedbread-ai/mxbai-embed-large-v1';
const DEFAULT_DIMS = 1024;

export class MixedbreadEmbeddingProvider extends BaseEmbeddingProvider {
  protected readonly providerLabel = 'mixedbread';
  private readonly model: string;
  private readonly dims: number;
  private readonly normalized: boolean;
  private readonly apiKey: string;
  private clientPromise: Promise<{
    embed: (args: {
      model: string;
      input: string[];
      normalized?: boolean;
    }) => Promise<{ data: { embedding: number[] }[] }>;
  }> | null = null;

  constructor(config: MixedbreadEmbeddingConfig = {}) {
    super(config);
    this.model = config.model ?? DEFAULT_MODEL;
    this.dims = config.dimensions ?? DEFAULT_DIMS;
    this.normalized = config.normalized !== false;
    const key = config.apiKey ?? process.env['MXBAI_API_KEY'] ?? process.env['MIXEDBREAD_API_KEY'];
    if (!key) {
      throw new EmbeddingError(
        'Mixedbread API key not provided. Set MXBAI_API_KEY (or MIXEDBREAD_API_KEY) or pass `apiKey` in config.',
      );
    }
    this.apiKey = key;
  }

  getDimensions(): number {
    return this.dims;
  }

  protected async fetchEmbeddings(texts: string[]): Promise<number[][]> {
    const client = await this.getClient();
    try {
      const response = await client.embed({
        model: this.model,
        input: texts,
        normalized: this.normalized,
      });
      return response.data.map((row) => row.embedding);
    } catch (error) {
      throw new EmbeddingError(`Mixedbread embed failed: ${getErrorMessage(error)}`, error);
    }
  }

  private async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        // @ts-expect-error - optional peer dependency
        const mod = (await import('@mixedbread-ai/sdk')) as unknown as {
          default: new (config: { apiKey: string }) => {
            embed: (args: {
              model: string;
              input: string[];
              normalized?: boolean;
            }) => Promise<{ data: { embedding: number[] }[] }>;
          };
        };
        return new mod.default({ apiKey: this.apiKey });
      })();
    }
    return this.clientPromise;
  }
}
