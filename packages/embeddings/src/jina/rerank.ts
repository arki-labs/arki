/** A Jina AI reranker over plain `fetch` (`POST /v1/rerank`). No SDK and no peer. */
import { z } from 'zod';

import type { FetchLike } from '../http.js';
import type { Reranker } from '../rerank/index.js';
import type { TokenCount } from '../types.js';
import {
  Cancelled,
  ConfigurationFailure,
  InputTooLong,
  InvalidOutput,
  ModelUnavailable,
  RateLimited,
  UnsupportedInput,
} from '../failures.js';
import { retryAfterMs } from '../http.js';
import { CHARS_PER_TOKEN } from '../tokens.js';

export type JinaRerankerOptions = {
  /** Default `'jina-reranker-v2-base-multilingual'`. */
  readonly id?: string;
  readonly apiKey: string;
  /** Default `'https://api.jina.ai/v1'`. */
  readonly baseURL?: string;
  readonly fetch?: FetchLike;
};

// https://jina.ai/reranker/ (read 2026-10-23): context per model, query plus one document. Jina
// chunks a longer document on its side and states no per-request document limit; 1000 keeps a
// request a sane size.
const JINA_RERANK_TOKENS: Readonly<Record<string, number>> = {
  'jina-reranker-v2-base-multilingual': 1024,
  'jina-reranker-v3': 131_072,
  'jina-reranker-m0': 10_000,
};
const MAX_DOCUMENTS = 1000;

/** `results[].{index, relevance_score}` and `usage.total_tokens`. */
const responseSchema = z.object({
  results: z.array(z.object({ index: z.number().int().nonnegative(), relevance_score: z.number() })),
  usage: z.object({ total_tokens: z.number() }).optional(),
});

/**
 * A Jina reranker. Jina has no documented "refuse a long document" switch: it chunks on its side,
 * so `rerank()`'s length check is the only guard under `'fail'`. That check estimates 4 characters
 * per token, which undercounts Romanian (near 3) and CJK text (near 1).
 *
 * @example
 * const reranker = createJinaReranker({ apiKey: process.env['JINA_API_KEY'] ?? '' });
 */
export function createJinaReranker(options: JinaRerankerOptions): Reranker | ConfigurationFailure {
  const id = options.id ?? 'jina-reranker-v2-base-multilingual';
  const maxInputTokens = JINA_RERANK_TOKENS[id];
  if (maxInputTokens === undefined) {
    return ConfigurationFailure({
      message: `jina reranker ${id} is not in the facts table (${Object.keys(JINA_RERANK_TOKENS).join(', ')})`,
    });
  }
  if (options.apiKey === '') return ConfigurationFailure({ message: 'jina apiKey is empty' });
  const baseURL = (options.baseURL ?? 'https://api.jina.ai/v1').replace(/\/+$/, '');
  const send: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));

  const rerank: Reranker['rerank'] = async (query, documents, { signal }) => {
    if (signal?.aborted) return Cancelled();
    if (documents.length > MAX_DOCUMENTS) return UnsupportedInput({ index: MAX_DOCUMENTS, part: 'batch' });
    if (documents.length === 0) {
      return { hits: [], usage: { tokens: { basis: 'reported', count: 0 }, requests: 0, cacheHits: 0 } };
    }

    let response: Response;
    try {
      response = await send(`${baseURL}/rerank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ model: id, query, documents, return_documents: false }),
        ...(signal ? { signal } : {}),
      });
    } catch {
      return signal?.aborted ? Cancelled() : ModelUnavailable({ model: id, reason: 'unreachable' });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 429) {
        const wait = retryAfterMs(header => response.headers.get(header));
        return RateLimited(wait === undefined ? {} : { retryAfterMs: wait });
      }
      if (response.status === 401 || response.status === 403) {
        return ConfigurationFailure({ message: `jina refused the API key (${response.status})` });
      }
      if (response.status === 404) return ModelUnavailable({ model: id, reason: 'unknown-model' });
      if ((response.status === 400 || response.status === 422) && /context length|too long|exceeds/i.test(text)) {
        const lengths = documents.map(document => document.length);
        const index = lengths.indexOf(Math.max(...lengths));
        const count = Math.ceil((query.length + (lengths[index] ?? 0)) / CHARS_PER_TOKEN);
        return InputTooLong({ index, tokens: { basis: 'estimated', count }, max: maxInputTokens });
      }
      return InvalidOutput({ reason: `jina answered ${response.status}: ${text.slice(0, 200)}` });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return signal?.aborted ? Cancelled() : InvalidOutput({ reason: 'jina answered malformed JSON' });
    }
    const body = responseSchema.safeParse(json);
    if (!body.success) {
      return InvalidOutput({ reason: `jina answered an unexpected shape: ${body.error.message.slice(0, 200)}` });
    }
    const { results } = body.data;
    // Every document scored once: a hole or a duplicate would rank a document the model never read.
    const indices = new Set(results.map(row => row.index));
    if (
      results.length !== documents.length ||
      indices.size !== documents.length ||
      results.some(row => row.index >= documents.length)
    ) {
      return InvalidOutput({ reason: `jina answered ${results.length} scores for ${documents.length} documents` });
    }
    const hits = results
      .map(row => ({ index: row.index, score: row.relevance_score }))
      .sort((left, right) => right.score - left.score);
    const total = body.data.usage?.total_tokens;
    const tokens: TokenCount = total === undefined ? { basis: 'unknown' } : { basis: 'reported', count: total };
    return { hits, usage: { tokens, requests: 1, cacheHits: 0 } };
  };

  return { provider: 'jina', id, local: false, maxDocuments: MAX_DOCUMENTS, maxInputTokens, rerank } satisfies Reranker;
}
