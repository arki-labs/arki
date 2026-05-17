/**
 * Jina reranker.
 *
 * No JS SDK from Jina — raw fetch to `api.jina.ai/v1/rerank`. Default model
 * `jina-reranker-v2-base-multilingual` (278M, 100+ langs, CC-BY-NC open
 * weights → hosted API only for commercial use).
 */

import type { Reranker, RerankOptions, RerankResult } from './types';

export type JinaRerankerConfig = {
  apiKey?: string;
  model?: string;
  baseURL?: string;
};

const DEFAULT_MODEL = 'jina-reranker-v2-base-multilingual';
const DEFAULT_BASE_URL = 'https://api.jina.ai/v1';

export class JinaReranker implements Reranker {
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: JinaRerankerConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseURL = config.baseURL ?? DEFAULT_BASE_URL;
    const key = config.apiKey ?? process.env['JINA_API_KEY'];
    if (!key) {
      throw new Error('Jina API key not provided. Set JINA_API_KEY or pass `apiKey`.');
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
    const response = await fetch(`${this.baseURL}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents,
        top_n: options.topK,
        return_documents: false,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`Jina rerank failed (${response.status}): ${text}`);
    }
    const json = (await response.json()) as {
      results: { index: number; relevance_score: number }[];
    };
    return json.results.map((r) => {
      const out: RerankResult = { index: r.index, score: r.relevance_score };
      if (options.returnDocuments) out.document = documents[r.index];
      return out;
    });
  }
}
