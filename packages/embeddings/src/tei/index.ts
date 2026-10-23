/**
 * `@arki/embeddings/tei`: a reranker on a Hugging Face Text Embeddings Inference server
 * (`POST /rerank`, a sequence-classification model such as `BAAI/bge-reranker-v2-m3`). Plain
 * `fetch`, no peer. TEI serves one model per server, so the operator states its limits.
 */
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

export type TeiRerankerOptions = {
  /** The model the server runs, e.g. `'BAAI/bge-reranker-v2-m3'`. TEI takes no model field; this names the scores. */
  readonly id: string;
  /** The server root, e.g. `'http://127.0.0.1:8080'`. */
  readonly baseURL: string;
  /** Sent as `Authorization: Bearer <apiKey>`. Local servers need none. */
  readonly apiKey?: string;
  /** HF commit the server runs. Part of the cache key. */
  readonly revision?: string;
  /** TEI `--max-client-batch-size`. Default 32. */
  readonly maxDocuments?: number;
  /** TEI `max_input_length` for query plus one document. Default 512. */
  readonly maxInputTokens?: number;
  readonly fetch?: FetchLike;
};

/** `TeiRerankerOptions`, checked by `createTeiReranker`; a type test locks it to the type. */
export const teiRerankerOptionsSchema = withOptionsJson(
  z
    .object({
      id: z.string().min(1),
      baseURL: z.url({ protocol: /^https?$/ }),
      apiKey: z.string().min(1).optional(),
      revision: z.string().min(1).optional(),
      maxDocuments: z.number().int().positive().optional(),
      maxInputTokens: z.number().int().positive().optional(),
      fetch: functionSchema<FetchLike>().optional(),
    })
    .readonly(),
);

/** https://huggingface.github.io/text-embeddings-inference/openapi.json (read 2026-10-23): a bare array. */
const responseSchema = z.array(z.object({ index: z.number().int().nonnegative(), score: z.number() }));
/** TEI's error body. */
const errorBodySchema = z.object({ error: z.string(), error_type: z.string() });
/** TEI's `x-compute-tokens` header: the tokens the request cost. */
const computeTokensSchema = z.coerce.number().int().nonnegative();

/**
 * A TEI reranker. `truncate` is sent as the caller chose (TEI's own default is `false`), so a pair
 * over `max_input_length` is `InputTooLong` unless `rerank()` was told to truncate. Scores are
 * TEI's normalised ones (`raw_scores: false`).
 *
 * @example
 * // text-embeddings-router --model-id BAAI/bge-reranker-v2-m3 --max-client-batch-size 32
 * const reranker = createTeiReranker({ id: 'BAAI/bge-reranker-v2-m3', baseURL: 'http://127.0.0.1:8080', maxInputTokens: 1024 });
 * if (isFailure(reranker)) throw new Error(reranker.message);
 */
export function createTeiReranker(input: TeiRerankerOptions): Reranker | ConfigurationFailure {
  const options = parseOptions(teiRerankerOptionsSchema, input, 'tei reranker');
  if (isFailure(options)) return options;
  const { id } = options;
  const maxDocuments = options.maxDocuments ?? 32;
  const maxInputTokens = options.maxInputTokens ?? 512;
  const baseURL = options.baseURL.replace(/\/+$/, '');
  const send: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));

  const rerank: Reranker['rerank'] = async (query, documents, { truncate, signal }) => {
    if (signal?.aborted) return Cancelled();
    if (documents.length > maxDocuments) return UnsupportedInput({ index: maxDocuments, part: 'batch' });
    if (documents.length === 0) {
      return { hits: [], usage: { tokens: { basis: 'reported', count: 0 }, requests: 0, cacheHits: 0 } };
    }

    let response: Response;
    try {
      response = await send(`${baseURL}/rerank`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
        },
        // Sent either way: a server started with `--auto-truncate` would otherwise cut silently.
        body: JSON.stringify({
          query,
          texts: documents,
          truncate: truncate === true,
          raw_scores: false,
          return_text: false,
        }),
        ...(signal ? { signal } : {}),
      });
    } catch {
      return signal?.aborted ? Cancelled() : ModelUnavailable({ model: id, reason: 'unreachable' });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const error = errorBodySchema.safeParse(parsed);
      const message = error.success ? error.data.error : text.slice(0, 200);
      if (response.status === 429) {
        const wait = retryAfterMs(header => response.headers.get(header));
        return RateLimited(wait === undefined ? {} : { retryAfterMs: wait });
      }
      if (response.status === 401 || response.status === 403) {
        return ConfigurationFailure({ message: `tei server refused the API key (${response.status})` });
      }
      if (response.status === 404) return ModelUnavailable({ model: id, reason: 'unknown-model' });
      if (response.status === 503) return ModelUnavailable({ model: id, reason: 'unreachable' });
      // TEI tokenization.rs: "`inputs` must have less than 512 tokens. Given: 600".
      if (/must have less than \d+ (?:tokens|characters)/.test(message)) {
        const lengths = documents.map(document => document.length);
        const index = lengths.indexOf(Math.max(...lengths));
        const count = Math.ceil((query.length + (lengths[index] ?? 0)) / CHARS_PER_TOKEN);
        return InputTooLong({ index, tokens: { basis: 'estimated', count }, max: maxInputTokens });
      }
      if (response.status === 413 || /batch size/.test(message)) return UnsupportedInput({ index: -1, part: 'batch' });
      return InvalidOutput({ reason: `tei server answered ${response.status}: ${message.slice(0, 200)}` });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return signal?.aborted ? Cancelled() : InvalidOutput({ reason: 'tei server answered malformed JSON' });
    }
    const rows = responseSchema.safeParse(json);
    if (!rows.success) {
      return InvalidOutput({ reason: `tei server answered an unexpected shape: ${rows.error.message.slice(0, 200)}` });
    }
    // Every document scored once: a hole or a duplicate would rank a document the model never read.
    const indices = new Set(rows.data.map(row => row.index));
    if (
      rows.data.length !== documents.length ||
      indices.size !== documents.length ||
      rows.data.some(row => row.index >= documents.length)
    ) {
      return InvalidOutput({
        reason: `tei server answered ${rows.data.length} scores for ${documents.length} documents`,
      });
    }
    const hits = rows.data
      .map(row => ({ index: row.index, score: row.score }))
      .sort((left, right) => right.score - left.score);
    const counted = computeTokensSchema.safeParse(response.headers.get('x-compute-tokens') ?? undefined);
    const tokens: TokenCount = counted.success ? { basis: 'reported', count: counted.data } : { basis: 'unknown' };
    return { hits, usage: { tokens, requests: 1, cacheHits: 0 } };
  };

  return {
    provider: 'tei',
    id,
    ...(options.revision === undefined ? {} : { revision: options.revision }),
    local: false,
    maxDocuments,
    maxInputTokens,
    rerank,
  };
}
