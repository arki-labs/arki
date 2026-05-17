/**
 * Cohere reranker.
 *
 * Uses AI SDK v6's native `rerank()` (Cohere is in the v6 allow-list along
 * with Bedrock and Together.ai). Default model `rerank-v3.5` — multilingual,
 * +15–20% NDCG@10 lift per Cohere docs.
 *
 * Cost: $2.00 per 1k searches. Above ~1M queries/mo, switch to self-hosted
 * mxbai-rerank-large-v2 via TEI (see `./tei.ts`) — ~28× cheaper.
 */

import { createCohere } from '@ai-sdk/cohere';
import { rerank } from 'ai';

import type { Reranker, RerankOptions, RerankResult } from './types';

export type CohereRerankerConfig = {
  apiKey?: string;
  /** e.g. `rerank-v3.5`, `rerank-multilingual-v3.0`, `rerank-english-v3.0`. */
  model?: string;
  baseURL?: string;
};

const DEFAULT_MODEL = 'rerank-v3.5';

export class CohereReranker implements Reranker {
  private readonly model: string;
  private readonly client: ReturnType<typeof createCohere>;

  constructor(config: CohereRerankerConfig = {}) {
    this.client = createCohere({ apiKey: config.apiKey, baseURL: config.baseURL });
    this.model = config.model ?? DEFAULT_MODEL;
  }

  getModel(): string {
    return this.model;
  }

  async rerank(
    query: string,
    documents: string[],
    options: RerankOptions = {},
  ): Promise<RerankResult[]> {
    const result = await rerank({
      model: this.client.reranking(this.model),
      query,
      documents,
      topN: options.topK,
    });
    return result.ranking.map((r) => {
      const out: RerankResult = { index: r.originalIndex, score: r.score };
      if (options.returnDocuments) out.document = r.document;
      return out;
    });
  }
}
