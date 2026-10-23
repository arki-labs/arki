/**
 * `@arki/embeddings/jina`: Jina AI over plain `fetch` (`POST /v1/embeddings`). No SDK and no peer,
 * so it runs on every runtime that has `fetch`. Hosted only.
 */
import { is, recordSchema } from '@arki/schema';

import type { FetchLike } from '../http.js';
import type { EmbeddingModel, NativeRequest, Purpose, TokenCount } from '../types.js';
import { Cancelled, ConfigurationFailure, InvalidOutput, ModelUnavailable, RateLimited } from '../failures.js';
import { mentionsContextLength, retryAfterMs, vectorsByIndex } from '../http.js';
import { NO_INSTRUCTION } from '../instructions.js';
import { providerInputTooLong } from '../tokens.js';

export type JinaModelOptions = {
  /** Default `'jina-embeddings-v3'`. */
  readonly id?: string;
  readonly apiKey: string;
  /** Default `'https://api.jina.ai/v1'`. */
  readonly baseURL?: string;
  readonly fetch?: FetchLike;
};

type JinaFacts = Pick<EmbeddingModel, 'dimensions' | 'matryoshka' | 'maxInputTokens' | 'maxBatch' | 'maxBatchTokens'>;

// https://api.jina.ai/openapi.json and https://jina.ai/embeddings/ (read 2026-10-22): v3 is 1024 dims,
// `dimensions` takes any integer 1-1024, context 8192 tokens. jina.ai recommends the v5 family over
// v3 for production but does not mark v3 deprecated or give a sunset date. The v5 dimensions are not
// stated on those pages, so v3 is the only listed model. Jina sets no per-request item limit ("There
// is no hard limit on the number of items per request", jina.ai/embeddings); 2048 keeps a request a sane size.
const JINA_FACTS: Readonly<Record<string, JinaFacts>> = {
  'jina-embeddings-v3': {
    dimensions: 1024,
    matryoshka: [1024, 768, 512, 256, 128, 64, 32],
    maxInputTokens: 8192,
    maxBatch: 2048,
    maxBatchTokens: 2048 * 8192,
  },
};

/** Jina's `task` per purpose for v3. Without a purpose no `task` is sent. */
const TASK = {
  query: 'retrieval.query',
  document: 'retrieval.passage',
  similarity: 'text-matching',
  classification: 'classification',
  clustering: 'separation',
} as const satisfies Record<Purpose, string>;

/** `usage.total_tokens` when Jina reports it. */
function reportedTokens(body: Readonly<Record<string, unknown>>): TokenCount {
  const usage = body['usage'];
  const total = is(usage, recordSchema) ? usage['total_tokens'] : undefined;
  return typeof total === 'number' && Number.isFinite(total)
    ? { basis: 'reported', count: total }
    : { basis: 'unknown' };
}

/**
 * A Jina model record. Jina versions its models by name, so `assurance` is `immutable`.
 *
 * @example
 * const model = createJinaModel({ apiKey: process.env['JINA_API_KEY'] ?? '' });
 */
export function createJinaModel(options: JinaModelOptions) {
  const id = options.id ?? 'jina-embeddings-v3';
  const facts = JINA_FACTS[id];
  if (facts === undefined) {
    return ConfigurationFailure({
      message: `jina model ${id} is not in the facts table (${Object.keys(JINA_FACTS).join(', ')})`,
    });
  }
  if (options.apiKey === '') return ConfigurationFailure({ message: 'jina apiKey is empty' });
  const baseURL = (options.baseURL ?? 'https://api.jina.ai/v1').replace(/\/+$/, '');
  const send: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));

  const embedTexts = async ({ texts, purpose, dimensions, truncate, signal }: NativeRequest) => {
    let response: Response;
    try {
      response = await send(`${baseURL}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model: id,
          input: texts,
          ...(purpose === undefined ? {} : { task: TASK[purpose] }),
          // Jina errors on a text over the limit unless told to cut: only the caller's choice cuts.
          truncate: truncate === true,
          normalized: true,
          ...(dimensions === undefined ? {} : { dimensions }),
        }),
        ...(signal ? { signal } : {}),
      });
    } catch {
      return signal?.aborted ? Cancelled() : ModelUnavailable({ model: id, reason: 'unreachable' });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 429) {
        const wait = retryAfterMs(name => response.headers.get(name));
        return RateLimited(wait === undefined ? {} : { retryAfterMs: wait });
      }
      if (response.status === 401 || response.status === 403) {
        return ConfigurationFailure({ message: `jina refused the API key (${response.status})` });
      }
      if (response.status === 404) return ModelUnavailable({ model: id, reason: 'unknown-model' });
      if ((response.status === 400 || response.status === 422) && mentionsContextLength(text)) {
        return providerInputTooLong(model, texts);
      }
      return InvalidOutput({ reason: `jina answered ${response.status}: ${text.slice(0, 200)}` });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return signal?.aborted ? Cancelled() : InvalidOutput({ reason: 'jina answered malformed JSON' });
    }
    const data = is(body, recordSchema) ? body['data'] : undefined;
    if (!is(body, recordSchema) || !Array.isArray(data)) {
      return InvalidOutput({ reason: 'jina answered without a data array' });
    }
    const vectors = vectorsByIndex(data, texts.length);
    if (typeof vectors === 'string') return InvalidOutput({ reason: `jina: ${vectors}` });
    return { vectors, tokens: reportedTokens(body) };
  };

  const model: EmbeddingModel = {
    provider: 'jina',
    id,
    assurance: 'immutable',
    local: false,
    ...facts,
    normalized: true,
    // Jina applies its own task adapter from `task`, so no text prefix here.
    instruction: NO_INSTRUCTION,
    inputs: ['text'],
    // `embedding_type: 'ubinary'` exists, but its bit order is not documented: enabled once a live run proves MSB first.
    quantizations: [],
    embedTexts,
  };
  return model;
}

export { createJinaReranker } from './rerank.js';
export type { JinaRerankerOptions } from './rerank.js';
