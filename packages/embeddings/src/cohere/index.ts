/**
 * `@arki/embeddings/cohere`: Cohere over plain `fetch` (`POST /v2/embed`). No SDK and no peer, so
 * it runs on every runtime that has `fetch`. Text only; images come in a later slice.
 */
import { is, recordSchema } from '@arki/schema';

import type { FetchLike } from '../http.js';
import type { EmbeddingModel, NativeRequest, Purpose, TokenCount } from '../types.js';
import { Cancelled, ConfigurationFailure, InvalidOutput, ModelUnavailable, RateLimited } from '../failures.js';
import { mentionsContextLength, retryAfterMs } from '../http.js';
import { NO_INSTRUCTION } from '../instructions.js';
import { providerInputTooLong } from '../tokens.js';

export type CohereModelOptions = {
  /** Default `'embed-v4.0'`. */
  readonly id?: string;
  readonly apiKey: string;
  /** Default `'https://api.cohere.com'`. */
  readonly baseURL?: string;
  readonly fetch?: FetchLike;
};

type CohereFacts = Pick<
  EmbeddingModel,
  'dimensions' | 'matryoshka' | 'maxInputTokens' | 'maxBatch' | 'maxBatchTokens'
>;

/**
 * From https://docs.cohere.com/docs/cohere-embed (sizes, context) and /reference/embed (96 texts per
 * call). Cohere states no tokens-per-request limit, so `maxBatchTokens` is our own cap.
 */
const COHERE_FACTS: Readonly<Record<string, CohereFacts>> = {
  'embed-v4.0': { dimensions: 1536, matryoshka: [1536, 1024, 512, 256], maxInputTokens: 128_000, maxBatch: 96, maxBatchTokens: 200_000 },
  'embed-english-v3.0': { dimensions: 1024, matryoshka: [], maxInputTokens: 512, maxBatch: 96, maxBatchTokens: 49_152 },
  'embed-multilingual-v3.0': { dimensions: 1024, matryoshka: [], maxInputTokens: 512, maxBatch: 96, maxBatchTokens: 49_152 },
};

/**
 * `input_type` is required from v3 on, so it is always sent. Cohere gives no advice for symmetric
 * similarity or for no purpose, so both use `search_document`: it is the type the docs name as the
 * default for a stored text, and it keeps two similar texts in the same space.
 */
function inputType(purpose: Purpose | undefined): 'search_query' | 'search_document' | 'classification' | 'clustering' {
  if (purpose === 'query') return 'search_query';
  if (purpose === 'classification' || purpose === 'clustering') return purpose;
  return 'search_document';
}

/** Which key of `embeddings` holds the vectors, and the name Cohere wants in `embedding_types`. `ubinary` is unsigned, bit-packed (our binary format). */
const EMBEDDING_TYPE = { float: 'float', int8: 'int8', binary: 'ubinary' } as const;

/** `meta.billed_units.input_tokens` when Cohere reports it. */
function reportedTokens(body: Readonly<Record<string, unknown>>): TokenCount {
  const meta = body['meta'];
  const billed = is(meta, recordSchema) ? meta['billed_units'] : undefined;
  const count = is(billed, recordSchema) ? billed['input_tokens'] : undefined;
  return typeof count === 'number' && Number.isFinite(count) ? { basis: 'reported', count } : { basis: 'unknown' };
}

/**
 * A Cohere model record. Cohere versions its models by name, so `assurance` is `immutable`.
 *
 * @example
 * const model = createCohereModel({ id: 'embed-v4.0', apiKey: process.env['COHERE_API_KEY'] ?? '' });
 */
export function createCohereModel(options: CohereModelOptions) {
  const id = options.id ?? 'embed-v4.0';
  const facts = COHERE_FACTS[id];
  if (facts === undefined) {
    return ConfigurationFailure({ message: `cohere model ${id} is not in the facts table (${Object.keys(COHERE_FACTS).join(', ')})` });
  }
  if (options.apiKey === '') return ConfigurationFailure({ message: 'cohere apiKey is empty' });
  const baseURL = (options.baseURL ?? 'https://api.cohere.com').replace(/\/+$/, '');
  const send: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));

  const embedTexts = async ({ texts, purpose, dimensions, quantization, truncate, signal }: NativeRequest) => {
    const type = EMBEDDING_TYPE[quantization ?? 'float'];
    let response: Response;
    try {
      response = await send(`${baseURL}/v2/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model: id,
          texts,
          input_type: inputType(purpose),
          embedding_types: [type],
          // Cohere cuts by default (`END`); ask for an error unless the caller chose to truncate.
          truncate: truncate === true ? 'END' : 'NONE',
          ...(dimensions === undefined ? {} : { output_dimension: dimensions }),
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
        return ConfigurationFailure({ message: `cohere refused the API key (${response.status})` });
      }
      if (response.status === 404) return ModelUnavailable({ model: id, reason: 'unknown-model' });
      if (response.status === 400 && mentionsContextLength(text)) return providerInputTooLong(model, texts);
      return InvalidOutput({ reason: `cohere answered ${response.status}: ${text.slice(0, 200)}` });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return signal?.aborted ? Cancelled() : InvalidOutput({ reason: 'cohere answered malformed JSON' });
    }
    const embeddings = is(body, recordSchema) ? body['embeddings'] : undefined;
    const vectors = is(embeddings, recordSchema) ? embeddings[type] : undefined;
    // Cohere rows carry no index: they come in input order, so the count is the only check possible here.
    if (!is(body, recordSchema) || !Array.isArray(vectors) || !vectors.every(item => Array.isArray(item))) {
      return InvalidOutput({ reason: `cohere answered without embeddings.${type}` });
    }
    return { vectors, tokens: reportedTokens(body) };
  };

  const model: EmbeddingModel = {
    provider: 'cohere',
    id,
    assurance: 'immutable',
    local: false,
    ...facts,
    // Cohere does not document unit-length output, so we do not claim it.
    normalized: false,
    // Cohere takes the purpose as `input_type`, so no text prefix here.
    instruction: NO_INSTRUCTION,
    inputs: ['text'],
    quantizations: ['int8', 'binary'],
    embedTexts,
  };
  return model;
}
