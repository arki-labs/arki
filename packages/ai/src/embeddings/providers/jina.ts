/**
 * Jina embedding provider.
 *
 * No first-party JS SDK from Jina — talks directly to `api.jina.ai/v1/embeddings`.
 *
 * Default model: `jina-embeddings-v3` (570M, 1024-d MRL, 8K ctx). Note: the
 * Jina v3/v4 open weights are CC-BY-NC 4.0 (non-commercial), so this hosted
 * API is the only commercial path. Jina AI was acquired by Elastic in
 * 2025-Q4 per SOTA S-02 — privacy posture may have changed; re-verify ToS.
 *
 * Late-chunking support: pass `lateChunking: true` (Jina-v3-specific feature
 * for long-document retrieval). The model encodes the whole document first
 * then chunks the vectors — gives +1–3 NDCG@10 on LongEmbed vs naive
 * chunk-then-encode.
 */

import { BaseEmbeddingProvider } from '../base';
import type { BaseEmbeddingConfig } from '../base';
import { EmbeddingError, getErrorMessage } from '../../errors';

export type JinaEmbeddingConfig = BaseEmbeddingConfig & {
  apiKey?: string;
  /** e.g. `jina-embeddings-v3`, `jina-embeddings-v2-base-en`. */
  model?: string;
  /** Embedding dimensions reported to consumers. */
  dimensions?: number;
  /** Late chunking (Jina v3 feature). Default: false. */
  lateChunking?: boolean;
  /** Task hint (improves retrieval quality on v3). */
  task?: 'retrieval.query' | 'retrieval.passage' | 'separation' | 'classification' | 'text-matching';
  baseURL?: string;
};

const DEFAULT_MODEL = 'jina-embeddings-v3';
const DEFAULT_DIMS = 1024;
const DEFAULT_BASE_URL = 'https://api.jina.ai/v1';

export class JinaEmbeddingProvider extends BaseEmbeddingProvider {
  protected readonly providerLabel = 'jina';
  private readonly model: string;
  private readonly dims: number;
  private readonly apiKey: string;
  private readonly lateChunking: boolean;
  private readonly task: JinaEmbeddingConfig['task'];
  private readonly baseURL: string;

  constructor(config: JinaEmbeddingConfig = {}) {
    super(config);
    this.model = config.model ?? DEFAULT_MODEL;
    this.dims = config.dimensions ?? DEFAULT_DIMS;
    this.lateChunking = config.lateChunking ?? false;
    this.task = config.task;
    this.baseURL = config.baseURL ?? DEFAULT_BASE_URL;
    const key = config.apiKey ?? process.env['JINA_API_KEY'];
    if (!key) {
      throw new EmbeddingError(
        'Jina API key not provided. Set JINA_API_KEY or pass `apiKey` in config.',
      );
    }
    this.apiKey = key;
  }

  getDimensions(): number {
    return this.dims;
  }

  protected async fetchEmbeddings(texts: string[]): Promise<number[][]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: texts,
      dimensions: this.dims,
      late_chunking: this.lateChunking,
    };
    if (this.task) body['task'] = this.task;

    try {
      const response = await fetch(`${this.baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new EmbeddingError(`Jina API error (${response.status}): ${text}`);
      }
      const json = (await response.json()) as { data: { embedding: number[] }[] };
      return json.data.map((row) => row.embedding);
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      throw new EmbeddingError(`Jina fetch failed: ${getErrorMessage(error)}`, error);
    }
  }
}
