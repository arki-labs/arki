/**
 * Voyage AI reranker.
 *
 * Backed by the official `voyageai` SDK (no AI SDK adapter — Voyage is not in
 * the AI SDK v6 `rerank()` allow-list). Default model `rerank-2.5` (32K ctx,
 * multilingual, instruction-following).
 *
 * Lazy-loaded.
 */

import type { Reranker, RerankOptions, RerankResult } from './types';

export type VoyageRerankerConfig = {
  apiKey?: string;
  /** e.g. `rerank-2.5`, `rerank-2`, `rerank-lite-1`. */
  model?: string;
};

const DEFAULT_MODEL = 'rerank-2.5';

export class VoyageReranker implements Reranker {
  private readonly model: string;
  private readonly apiKey: string;
  private clientPromise: Promise<{
    rerank: (args: {
      query: string;
      documents: string[];
      model: string;
      topK?: number;
    }) => Promise<{ data?: { index: number; relevanceScore: number }[] }>;
  }> | null = null;

  constructor(config: VoyageRerankerConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    const key = config.apiKey ?? process.env['VOYAGE_API_KEY'];
    if (!key) {
      throw new Error('Voyage API key not provided. Set VOYAGE_API_KEY or pass `apiKey`.');
    }
    this.apiKey = key;
  }

  getModel(): string {
    return this.model;
  }

  async rerank(
    query: string,
    documents: string[],
    options: RerankOptions = {},
  ): Promise<RerankResult[]> {
    const client = await this.getClient();
    const response = await client.rerank({
      query,
      documents,
      model: this.model,
      topK: options.topK,
    });
    return (response.data ?? []).map((r) => {
      const out: RerankResult = { index: r.index, score: r.relevanceScore };
      if (options.returnDocuments) out.document = documents[r.index];
      return out;
    });
  }

  private async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        // @ts-expect-error - optional peer dependency
        const mod = (await import('voyageai')) as unknown as {
          VoyageAIClient: new (config: { apiKey: string }) => {
            rerank: (args: {
              query: string;
              documents: string[];
              model: string;
              topK?: number;
            }) => Promise<{ data?: { index: number; relevanceScore: number }[] }>;
          };
        };
        return new mod.VoyageAIClient({ apiKey: this.apiKey });
      })();
    }
    return this.clientPromise;
  }
}
