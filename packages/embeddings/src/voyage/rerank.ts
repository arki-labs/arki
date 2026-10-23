/** A Voyage AI reranker over plain `fetch` (`POST /v1/rerank`). No SDK and no peer. */
import { isFailure } from '@arki/failure';
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
import { functionSchema, parseOptions, withOptionsJson } from '../schemas.js';
import { retryAfterMs } from '../http.js';
import { CHARS_PER_TOKEN } from '../tokens.js';

export type VoyageRerankerOptions = {
  /** Default `'rerank-2.5'`. */
  readonly id?: string;
  readonly apiKey: string;
  /** Default `'https://api.voyageai.com/v1'`. */
  readonly baseURL?: string;
  readonly fetch?: FetchLike;
};

/** `VoyageRerankerOptions`, checked by `createVoyageReranker`; a type test locks it to the type. */
export const voyageRerankerOptionsSchema = withOptionsJson(
  z
    .object({
      id: z.string().min(1).optional(),
      apiKey: z.string().min(1),
      baseURL: z.url({ protocol: /^https?$/ }).optional(),
      fetch: functionSchema<FetchLike>().optional(),
    })
    .readonly(),
);

// https://docs.voyageai.com/reference/reranker-api (read 2026-10-23): tokens of query plus one
// document; at most 1000 documents. A request also caps query tokens × documents + document tokens
// (600K for these models), which a top-1000 of long documents can pass: Voyage then answers 400.
const VOYAGE_RERANK_TOKENS: Readonly<Record<string, number>> = {
  'rerank-2.5': 32_000,
  'rerank-2.5-lite': 32_000,
  'rerank-2': 16_000,
  'rerank-2-lite': 8000,
};
const MAX_DOCUMENTS = 1000;

/** `data[].{index, relevance_score}` sorted by score, and `usage.total_tokens`. */
const responseSchema = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative(), relevance_score: z.number() })),
  usage: z.object({ total_tokens: z.number() }).optional(),
});

/**
 * A Voyage reranker. `truncation` is sent as the caller chose, so a document over the limit is
 * refused (`InputTooLong`) unless `rerank()` was told to truncate.
 *
 * @example
 * const reranker = createVoyageReranker({ apiKey: process.env['VOYAGE_API_KEY'] ?? '', id: 'rerank-2.5-lite' });
 */
export function createVoyageReranker(input: VoyageRerankerOptions): Reranker | ConfigurationFailure {
  const options = parseOptions(voyageRerankerOptionsSchema, input, 'voyage reranker');
  if (isFailure(options)) return options;
  const id = options.id ?? 'rerank-2.5';
  const maxInputTokens = VOYAGE_RERANK_TOKENS[id];
  if (maxInputTokens === undefined) {
    return ConfigurationFailure({
      message: `voyage reranker ${id} is not in the facts table (${Object.keys(VOYAGE_RERANK_TOKENS).join(', ')})`,
    });
  }
  const baseURL = (options.baseURL ?? 'https://api.voyageai.com/v1').replace(/\/+$/, '');
  const send: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));

  const rerank: Reranker['rerank'] = async (query, documents, { truncate, signal }) => {
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
        // Voyage cuts by default; only the caller's choice cuts here.
        body: JSON.stringify({ model: id, query, documents, truncation: truncate === true }),
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
        return ConfigurationFailure({ message: `voyage refused the API key (${response.status})` });
      }
      if (response.status === 404) return ModelUnavailable({ model: id, reason: 'unknown-model' });
      // With `truncation: false` Voyage answers 400 for a pair over the context length.
      if (response.status === 400 && /context length|truncation|too long/i.test(text)) {
        const lengths = documents.map(document => document.length);
        const index = lengths.indexOf(Math.max(...lengths));
        const count = Math.ceil((query.length + (lengths[index] ?? 0)) / CHARS_PER_TOKEN);
        return InputTooLong({ index, tokens: { basis: 'estimated', count }, max: maxInputTokens });
      }
      return InvalidOutput({ reason: `voyage answered ${response.status}: ${text.slice(0, 200)}` });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return signal?.aborted ? Cancelled() : InvalidOutput({ reason: 'voyage answered malformed JSON' });
    }
    const body = responseSchema.safeParse(json);
    if (!body.success) {
      return InvalidOutput({ reason: `voyage answered an unexpected shape: ${body.error.message.slice(0, 200)}` });
    }
    const { data } = body.data;
    // Every document scored once: a hole or a duplicate would rank a document the model never read.
    const indices = new Set(data.map(row => row.index));
    if (
      data.length !== documents.length ||
      indices.size !== documents.length ||
      data.some(row => row.index >= documents.length)
    ) {
      return InvalidOutput({ reason: `voyage answered ${data.length} scores for ${documents.length} documents` });
    }
    const hits = data
      .map(row => ({ index: row.index, score: row.relevance_score }))
      .sort((left, right) => right.score - left.score);
    const total = body.data.usage?.total_tokens;
    const tokens: TokenCount = total === undefined ? { basis: 'unknown' } : { basis: 'reported', count: total };
    return { hits, usage: { tokens, requests: 1, cacheHits: 0 } };
  };

  return {
    provider: 'voyage',
    id,
    local: false,
    maxDocuments: MAX_DOCUMENTS,
    maxInputTokens,
    rerank,
  } satisfies Reranker;
}
