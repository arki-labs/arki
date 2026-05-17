/**
 * Voyage AI embedding provider.
 *
 * Backed by the official `voyageai` SDK (Voyage now operates under MongoDB,
 * acquired 2025-Q1). No `@ai-sdk/voyage` exists; the community
 * `voyage-ai-provider` is the alternative if AI SDK alignment matters more
 * than the official client.
 *
 * Default model: `voyage-3.5` (1024-d, 32K ctx). For quality-leader use
 * `voyage-3-large` ($0.18/M) or `voyage-4-large` ($0.12/M). For low-cost use
 * `voyage-3-lite` / `voyage-4-lite` ($0.02/M). For code retrieval use
 * `voyage-code-3` ($0.18/M).
 *
 * Notable feature (per SOTA spark S-03 / G-14): voyage-3-large and
 * voyage-4-large claim shared embedding space within the v4 family, allowing
 * upgrade without re-embedding the corpus.
 *
 * Lazy-loaded via dynamic import — `voyageai` is not a hot path for most apps.
 */

import { BaseEmbeddingProvider  } from '../base';
import type {BaseEmbeddingConfig} from '../base';
import { EmbeddingError, getErrorMessage } from '../../errors';
import { env } from '../../env';

export type VoyageEmbeddingConfig = BaseEmbeddingConfig & {
  apiKey?: string;
  /** e.g. `voyage-3.5`, `voyage-3-large`, `voyage-4-large`, `voyage-code-3`. */
  model?: string;
  /** Required for our internal API; defaults to 1024 for most v3/v4 models. */
  dimensions?: number;
  /** `query` or `document` — Voyage benefits from input-type hints. */
  inputType?: 'query' | 'document';
};

const DEFAULT_MODEL = 'voyage-3.5';
const DEFAULT_DIMS = 1024;

export class VoyageEmbeddingProvider extends BaseEmbeddingProvider {
  protected readonly providerLabel = 'voyage';
  private readonly model: string;
  private readonly dims: number;
  private readonly inputType: 'query' | 'document' | undefined;
  private readonly apiKey: string;
  // Lazy: stays `null` until first fetch; avoids the import cost for unused providers.
  private clientPromise: Promise<{
    embed: (args: {
      input: string[];
      model: string;
      inputType?: 'query' | 'document';
    }) => Promise<{ data?: { embedding?: number[] }[] }>;
  }> | null = null;

  constructor(config: VoyageEmbeddingConfig = {}) {
    super(config);
    this.model = config.model ?? DEFAULT_MODEL;
    this.dims = config.dimensions ?? DEFAULT_DIMS;
    this.inputType = config.inputType;
    const key = config.apiKey ?? process.env['VOYAGE_API_KEY'];
    if (!key) {
      throw new EmbeddingError(
        'Voyage API key not provided. Set VOYAGE_API_KEY or pass `apiKey` in config.',
      );
    }
    this.apiKey = key;
    // Suppress unused-import warning for env (kept for parity with sibling providers).
    void env;
  }

  getDimensions(): number {
    return this.dims;
  }

  protected async fetchEmbeddings(texts: string[]): Promise<number[][]> {
    const client = await this.getClient();
    try {
      const response = await client.embed({
        input: texts,
        model: this.model,
        inputType: this.inputType,
      });
      const data = response.data ?? [];
      return data.map((row, i) => {
        const emb = row.embedding;
        if (!emb) throw new EmbeddingError(`Voyage returned no embedding for index ${i}`);
        return emb;
      });
    } catch (error) {
      throw new EmbeddingError(`Voyage embed failed: ${getErrorMessage(error)}`, error);
    }
  }

  private async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        // @ts-expect-error - optional peer dependency
        const mod = (await import('voyageai')) as unknown as {
          VoyageAIClient: new (config: { apiKey: string }) => {
            embed: (args: {
              input: string[];
              model: string;
              inputType?: 'query' | 'document';
            }) => Promise<{ data?: { embedding?: number[] }[] }>;
          };
        };
        return new mod.VoyageAIClient({ apiKey: this.apiKey });
      })();
    }
    return this.clientPromise;
  }
}
