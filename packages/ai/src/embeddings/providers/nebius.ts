/**
 * Nebius AI (Token Factory) embedding provider.
 *
 * Nebius exposes an OpenAI-compatible `/v1/embeddings` endpoint serving frontier OSS embedding
 * models — notably `Qwen/Qwen3-Embedding-8B` (4096-d, MMTEB leader), the cloud path to
 * Qwen3-Embedding without self-hosting the 8B weights. Talks directly to the REST API (no SDK) so
 * a whole batch (`input: string[]`) goes in one call and the request body stays fully controlled —
 * the same reason `jina.ts` bypasses an SDK.
 *
 * Default model: `Qwen/Qwen3-Embedding-8B` (4096-d). Trade down to `Qwen/Qwen3-Embedding-4B`
 * (2560-d) or `-0.6B` (1024-d) via `model` + `dimensions` when cost/latency matter.
 */

import { BaseEmbeddingProvider } from '../base';
import type { BaseEmbeddingConfig } from '../base';
import { EmbeddingError, getErrorMessage } from '../../errors';

export type NebiusEmbeddingConfig = BaseEmbeddingConfig & {
  apiKey?: string;
  /** e.g. `Qwen/Qwen3-Embedding-8B`. */
  model?: string;
  /** Embedding dimensions reported to consumers. Must match the model. */
  dimensions?: number;
  /** OpenAI-compatible base URL. Defaults to the Nebius Token Factory endpoint. */
  baseURL?: string;
};

const DEFAULT_MODEL = 'Qwen/Qwen3-Embedding-8B';
const DEFAULT_DIMS = 4096;
const DEFAULT_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';

export class NebiusEmbeddingProvider extends BaseEmbeddingProvider {
  protected readonly providerLabel = 'nebius';
  private readonly model: string;
  private readonly dims: number;
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: NebiusEmbeddingConfig = {}) {
    super(config);
    this.model = config.model ?? DEFAULT_MODEL;
    this.dims = config.dimensions ?? DEFAULT_DIMS;
    this.baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const key = config.apiKey ?? process.env['NEBIUS_API_KEY'];
    if (!key) {
      throw new EmbeddingError(
        'Nebius API key not provided. Set NEBIUS_API_KEY or pass `apiKey` in config.',
      );
    }
    this.apiKey = key;
  }

  getDimensions(): number {
    return this.dims;
  }

  protected async fetchEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      const response = await fetch(`${this.baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new EmbeddingError(`Nebius API error (${response.status}): ${text}`);
      }
      const json = (await response.json()) as { data: { embedding: number[]; index: number }[] };
      // The OpenAI embeddings shape carries each row's original request position in `index`; response
      // order is not guaranteed, so place each embedding at its index rather than trusting array order.
      const out: number[][] = Array.from({ length: json.data.length });
      for (const row of json.data) out[row.index] = row.embedding;
      return out;
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      throw new EmbeddingError(`Nebius fetch failed: ${getErrorMessage(error)}`, error);
    }
  }
}
