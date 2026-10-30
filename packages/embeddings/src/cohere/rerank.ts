/**
 * Rerankers over Cohere's rerank protocol: Cohere itself (`POST /v2/rerank`) and the servers that
 * copy it (Infinity, vLLM, llama.cpp `--reranking`, all at `POST /rerank`). Plain `fetch`, no peer.
 */
import { z } from 'zod';

import { isFailure } from '@arki/failure';

import type { FetchLike } from '../http.js';
import type { Reranker, RerankProviderName } from '../rerank/index.js';
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
import { retryAfterMs, requestSignal } from '../http.js';
import { functionSchema, parseOptions, withOptionsJson } from '../schemas.js';
import { CHARS_PER_TOKEN } from '../tokens.js';

export type CohereRerankerOptions = {
  /** Default `'rerank-v3.5'`. */
  readonly id?: string;
  readonly apiKey: string;
  /** Default `'https://api.cohere.com/v2'`. */
  readonly baseURL?: string;
  readonly fetch?: FetchLike;
};

export type CohereCompatibleRerankerOptions = {
  /** The server root, e.g. `'http://127.0.0.1:7997'`; `/rerank` is appended. */
  readonly baseURL: string;
  /** The model the server runs, sent as `model`, e.g. `'BAAI/bge-reranker-v2-m3'`. */
  readonly id: string;
  /** Sent as `Authorization: Bearer <apiKey>`. Local servers need none. */
  readonly apiKey?: string;
  /** The weights' commit, when you pin it on the server. Part of the cache key. */
  readonly revision?: string;
  /** Default 1000. Infinity takes up to 2048. */
  readonly maxDocuments?: number;
  /** Tokens of query plus one document the server's model reads. Default 512. */
  readonly maxInputTokens?: number;
  readonly fetch?: FetchLike;
};

/** `CohereRerankerOptions`, checked by `createCohereReranker`; a type test locks it to the type. */
export const cohereRerankerOptionsSchema = withOptionsJson(
  z
    .object({
      id: z.string().min(1).optional(),
      apiKey: z.string().min(1),
      baseURL: z.url({ protocol: /^https?$/ }).optional(),
      fetch: functionSchema<FetchLike>().optional(),
    })
    .readonly(),
);

/** `CohereCompatibleRerankerOptions`, checked by `createCohereCompatibleReranker`; a type test locks it. */
export const cohereCompatibleRerankerOptionsSchema = withOptionsJson(
  z
    .object({
      baseURL: z.url({ protocol: /^https?$/ }),
      id: z.string().min(1),
      apiKey: z.string().min(1).optional(),
      revision: z.string().min(1).optional(),
      maxDocuments: z.number().int().positive().optional(),
      maxInputTokens: z.number().int().positive().optional(),
      fetch: functionSchema<FetchLike>().optional(),
    })
    .readonly(),
);

// https://docs.cohere.com/docs/rerank (read 2026-10-23): context is query plus one document. Cohere
// advises at most 1000 documents per request. 32k is read as 32 000, the smaller reading.
const COHERE_RERANK_TOKENS: Readonly<Record<string, number>> = {
  'rerank-v3.5': 4096,
  'rerank-english-v3.0': 4096,
  'rerank-multilingual-v3.0': 4096,
  'rerank-v4.0-pro': 32_000,
  'rerank-v4.0-fast': 32_000,
  'rerank-v5.0-pro': 32_000,
  'rerank-v5.0-fast': 32_000,
};
const COHERE_MAX_DOCUMENTS = 1000;

/**
 * Cohere answers `meta.billed_units`; Infinity, vLLM and llama.cpp answer `usage`. Every one sends
 * `results[].{index, relevance_score}`, sorted or not.
 */
const rerankResponseSchema = z.object({
  results: z.array(z.object({ index: z.number().int().nonnegative(), relevance_score: z.number() })),
  meta: z.object({ billed_units: z.object({ input_tokens: z.number().optional() }).optional() }).optional(),
  usage: z.object({ total_tokens: z.number().optional(), prompt_tokens: z.number().optional() }).optional(),
});

type Wire = {
  readonly provider: RerankProviderName;
  readonly id: string;
  readonly url: string;
  readonly apiKey: string | undefined;
  readonly maxDocuments: number;
  readonly maxInputTokens: number;
  readonly send: FetchLike;
  /** Cohere only: how much of a document it reads. Its default (4096) would cut v4 documents silently. */
  readonly maxTokensPerDoc?: number;
};

/** The longest document as `InputTooLong`: the protocol names neither the document nor its count. */
function longestTooLong(query: string, documents: readonly string[], max: number) {
  const lengths = documents.map(document => document.length);
  const index = lengths.indexOf(Math.max(...lengths));
  const characters = query.length + (lengths[index] ?? 0);
  return InputTooLong({ index, tokens: { basis: 'estimated', count: Math.ceil(characters / CHARS_PER_TOKEN) }, max });
}

function protocolReranker(wire: Wire): Reranker {
  const name = wire.provider;
  const rerank: Reranker['rerank'] = async (query, documents, { signal }) => {
    if (signal?.aborted) return Cancelled();
    if (documents.length > wire.maxDocuments) return UnsupportedInput({ index: wire.maxDocuments, part: 'batch' });
    if (documents.length === 0) {
      return { hits: [], usage: { tokens: { basis: 'reported', count: 0 }, requests: 0, cacheHits: 0 } };
    }

    let response: Response;
    try {
      response = await wire.send(wire.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(wire.apiKey === undefined ? {} : { authorization: `Bearer ${wire.apiKey}` }),
        },
        body: JSON.stringify({
          model: wire.id,
          query,
          documents,
          ...(wire.maxTokensPerDoc === undefined ? {} : { max_tokens_per_doc: wire.maxTokensPerDoc }),
        }),
        signal: requestSignal(signal),
      });
    } catch {
      return signal?.aborted ? Cancelled() : ModelUnavailable({ model: wire.id, reason: 'unreachable' });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 429) {
        const wait = retryAfterMs(header => response.headers.get(header));
        return RateLimited(wait === undefined ? {} : { retryAfterMs: wait });
      }
      if (response.status === 401 || response.status === 403) {
        return ConfigurationFailure({ message: `${name} refused the API key (${response.status})` });
      }
      if (response.status === 404) return ModelUnavailable({ model: wire.id, reason: 'unknown-model' });
      if (response.status === 503) return ModelUnavailable({ model: wire.id, reason: 'unreachable' });
      // vLLM: "This model's maximum context length is 512 tokens"; llama.cpp: "input is too large to process".
      if (
        (response.status === 400 || response.status === 422) &&
        /context length|too (?:large|long)|max(?:imum)? [^.]*tokens/i.test(text)
      ) {
        return longestTooLong(query, documents, wire.maxInputTokens);
      }
      // A server fault is worth another try: it is the same unreachable failure a dropped connection is.
      if (response.status >= 500) return ModelUnavailable({ model: wire.id, reason: 'unreachable' });
      return InvalidOutput({ reason: `${name} answered ${response.status}: ${text.slice(0, 200)}` });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return signal?.aborted ? Cancelled() : InvalidOutput({ reason: `${name} answered malformed JSON` });
    }
    const body = rerankResponseSchema.safeParse(json);
    if (!body.success) {
      return InvalidOutput({ reason: `${name} answered an unexpected shape: ${body.error.message.slice(0, 200)}` });
    }
    const { results } = body.data;
    // Every document scored once: a hole or a duplicate would rank a document the model never read.
    const indices = new Set(results.map(row => row.index));
    if (
      results.length !== documents.length ||
      indices.size !== documents.length ||
      results.some(row => row.index >= documents.length)
    ) {
      return InvalidOutput({ reason: `${name} answered ${results.length} scores for ${documents.length} documents` });
    }
    const hits = results
      .map(row => ({ index: row.index, score: row.relevance_score }))
      .sort((left, right) => right.score - left.score);
    const count =
      body.data.meta?.billed_units?.input_tokens ?? body.data.usage?.total_tokens ?? body.data.usage?.prompt_tokens;
    const tokens: TokenCount = count === undefined ? { basis: 'unknown' } : { basis: 'reported', count };
    return { hits, usage: { tokens, requests: 1, cacheHits: 0 } };
  };

  return {
    provider: wire.provider,
    id: wire.id,
    local: false,
    maxDocuments: wire.maxDocuments,
    maxInputTokens: wire.maxInputTokens,
    rerank,
  };
}

/**
 * A Cohere reranker. Cohere has no "refuse a long document" switch: past `maxInputTokens` it cuts or
 * chunks on its side, so `rerank()`'s length check is the only guard under `'fail'`. That check
 * estimates 4 characters per token, which undercounts Romanian (near 3) and CJK text (near 1): such
 * a document can pass it and be cut by Cohere. Split such text before ranking.
 *
 * @example
 * const reranker = createCohereReranker({ apiKey: process.env['COHERE_API_KEY'] ?? '' });
 * if (isFailure(reranker)) throw new Error(reranker.message);
 * const ranked = await rerank(reranker, 'refund policy', hits, { text: hit => hit.text, topK: 10 });
 */
export function createCohereReranker(input: CohereRerankerOptions): Reranker | ConfigurationFailure {
  const options = parseOptions(cohereRerankerOptionsSchema, input, 'cohere reranker');
  if (isFailure(options)) return options;
  const id = options.id ?? 'rerank-v3.5';
  const maxInputTokens = COHERE_RERANK_TOKENS[id];
  if (maxInputTokens === undefined) {
    return ConfigurationFailure({
      message: `cohere reranker ${id} is not in the facts table (${Object.keys(COHERE_RERANK_TOKENS).join(', ')})`,
    });
  }
  const baseURL = (options.baseURL ?? 'https://api.cohere.com/v2').replace(/\/+$/, '');
  return protocolReranker({
    provider: 'cohere',
    id,
    url: `${baseURL}/rerank`,
    apiKey: options.apiKey,
    maxDocuments: COHERE_MAX_DOCUMENTS,
    maxInputTokens,
    maxTokensPerDoc: maxInputTokens,
    send: options.fetch ?? ((url, init) => fetch(url, init)),
  });
}

/**
 * A reranker on a server that speaks Cohere's protocol: Infinity, vLLM or llama.cpp started with
 * `--reranking`. The operator decides what the server runs, so state `maxInputTokens` and, to key
 * a cache on the weights, `revision`.
 *
 * @example
 * // infinity_emb v2 --model-id BAAI/bge-reranker-v2-m3
 * const reranker = createCohereCompatibleReranker({ baseURL: 'http://127.0.0.1:7997', id: 'BAAI/bge-reranker-v2-m3', maxInputTokens: 1024 });
 */
export function createCohereCompatibleReranker(
  input: CohereCompatibleRerankerOptions,
): Reranker | ConfigurationFailure {
  const options = parseOptions(cohereCompatibleRerankerOptionsSchema, input, 'cohere-compatible reranker');
  if (isFailure(options)) return options;
  const maxDocuments = options.maxDocuments ?? 1000;
  const maxInputTokens = options.maxInputTokens ?? 512;
  const reranker = protocolReranker({
    provider: 'cohere-compatible',
    id: options.id,
    url: `${options.baseURL.replace(/\/+$/, '')}/rerank`,
    apiKey: options.apiKey,
    maxDocuments,
    maxInputTokens,
    send: options.fetch ?? ((url, init) => fetch(url, init)),
  });
  return options.revision === undefined ? reranker : { ...reranker, revision: options.revision };
}
