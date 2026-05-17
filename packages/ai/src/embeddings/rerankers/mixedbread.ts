/**
 * Mixedbread reranker (hosted).
 *
 * Default model `mixedbread-ai/mxbai-rerank-large-v1` (or v2 — verify against
 * your account tier). Lazy-loaded via the same `@mixedbread-ai/sdk` used by
 * the embedding provider.
 *
 * For self-hosted mxbai-rerank-large-v2, prefer `./tei.ts` — same model
 * weights, ~28× cheaper at high query volume.
 */

import type { Reranker, RerankOptions, RerankResult } from './types';

export type MixedbreadRerankerConfig = {
  apiKey?: string;
  model?: string;
};

const DEFAULT_MODEL = 'mixedbread-ai/mxbai-rerank-large-v1';

export class MixedbreadReranker implements Reranker {
  private readonly model: string;
  private readonly apiKey: string;
  private clientPromise: Promise<{
    rerank: (args: {
      query: string;
      input: string[];
      model: string;
      top_k?: number;
    }) => Promise<{ data: { index: number; score: number }[] }>;
  }> | null = null;

  constructor(config: MixedbreadRerankerConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    const key = config.apiKey ?? process.env['MXBAI_API_KEY'] ?? process.env['MIXEDBREAD_API_KEY'];
    if (!key) {
      throw new Error(
        'Mixedbread API key not provided. Set MXBAI_API_KEY (or MIXEDBREAD_API_KEY) or pass `apiKey`.',
      );
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
      input: documents,
      model: this.model,
      top_k: options.topK,
    });
    return response.data.map((r) => {
      const out: RerankResult = { index: r.index, score: r.score };
      if (options.returnDocuments) out.document = documents[r.index];
      return out;
    });
  }

  private async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        // @ts-expect-error - optional peer dependency
        const mod = (await import('@mixedbread-ai/sdk')) as unknown as {
          default: new (config: { apiKey: string }) => {
            rerank: (args: {
              query: string;
              input: string[];
              model: string;
              top_k?: number;
            }) => Promise<{ data: { index: number; score: number }[] }>;
          };
        };
        return new mod.default({ apiKey: this.apiKey });
      })();
    }
    return this.clientPromise;
  }
}
