/**
 * TEI reranker — self-hosted cross-encoder via Hugging Face Text Embeddings
 * Inference.
 *
 * Same shape works for the recommendation-grid winners:
 *   - `mxbai-rerank-large-v2`  — 1.5B, Apache 2.0, BEIR 57.5 (claims to beat Cohere)
 *   - `BAAI/bge-reranker-v2-m3`  — 568M, Apache 2.0
 *   - `BAAI/bge-reranker-v2-gemma`  — 2B, Apache 2.0
 *   - `Qwen/Qwen3-Reranker-{0.6,4,8}B`  — Apache 2.0
 *
 * Cost-economics flip above 1M queries/mo: self-host on 2× A10G HA (~$700/mo)
 * beats Cohere Rerank ($20k/mo at 10M queries) by ~28× per the SOTA finding
 * B-01-22.
 *
 * Talks to TEI's `POST /rerank` endpoint (NOT OpenAI-compatible — TEI exposes
 * a custom rerank route alongside the OpenAI-compatible `/v1/embeddings`).
 */

import type { Reranker, RerankOptions, RerankResult } from './types';

export type TeiRerankerConfig = {
  /** Required — base URL of the TEI server (e.g. `http://tei-rerank.internal:8080`). */
  baseURL: string;
  /** Model id reported back. TEI doesn't accept a model param on the wire (one model per server). */
  model?: string;
  /** API key if your TEI deployment is auth-gated. */
  apiKey?: string;
  /** Force truncation if a document exceeds the model's context window. Default: true. */
  truncate?: boolean;
};

export class TeiReranker implements Reranker {
  private readonly baseURL: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly truncate: boolean;

  constructor(config: TeiRerankerConfig) {
    this.baseURL = config.baseURL.replace(/\/$/, '');
    this.model = config.model ?? 'tei-cross-encoder';
    this.apiKey = config.apiKey;
    this.truncate = config.truncate !== false;
  }

  getModel(): string {
    return this.model;
  }

  async rerank(
    query: string,
    documents: string[],
    options: RerankOptions = {},
  ): Promise<RerankResult[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const response = await fetch(`${this.baseURL}/rerank`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        texts: documents,
        truncate: this.truncate,
        raw_scores: false,
        return_text: false,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`TEI rerank failed (${response.status}): ${text}`);
    }
    // TEI returns `[{ index, score }, ...]` already sorted desc.
    const results = (await response.json()) as { index: number; score: number }[];
    const limited =
      typeof options.topK === 'number' ? results.slice(0, options.topK) : results;
    return limited.map((r) => {
      const out: RerankResult = { index: r.index, score: r.score };
      if (options.returnDocuments) out.document = documents[r.index];
      return out;
    });
  }
}
