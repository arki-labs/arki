/**
 * `@arki/embeddings/voyage`: Voyage AI over plain `fetch` (`POST /v1/embeddings`). No SDK and no
 * peer, so it runs on every runtime that has `fetch`.
 */
import { is, recordSchema } from '@arki/schema';

import type { FetchLike } from '../http.js';
import type { EmbeddingModel, NativeRequest, Purpose, TokenCount } from '../types.js';
import { Cancelled, ConfigurationFailure, InvalidOutput, ModelUnavailable, RateLimited } from '../failures.js';
import { mentionsContextLength, retryAfterMs, vectorsByIndex } from '../http.js';
import { NO_INSTRUCTION } from '../instructions.js';
import { providerInputTooLong } from '../tokens.js';

export type VoyageModelOptions = {
  /** Default `'voyage-3.5'`. */
  readonly id?: string;
  readonly apiKey: string;
  /** Default `'https://api.voyageai.com/v1'`. */
  readonly baseURL?: string;
  readonly fetch?: FetchLike;
};

type VoyageFacts = Pick<
  EmbeddingModel,
  'dimensions' | 'matryoshka' | 'maxInputTokens' | 'maxBatch' | 'maxBatchTokens'
>;

/** Sizes every listed model can make besides its native 1024. */
const VOYAGE_SIZES = [2048, 1024, 512, 256] as const;

/** From https://docs.voyageai.com/docs/embeddings: 32k context, 1000 texts, tokens per request differ by model. */
const VOYAGE_FACTS: Readonly<Record<string, VoyageFacts>> = {
  'voyage-3.5': { dimensions: 1024, matryoshka: VOYAGE_SIZES, maxInputTokens: 32_000, maxBatch: 1000, maxBatchTokens: 320_000 },
  'voyage-3.5-lite': { dimensions: 1024, matryoshka: VOYAGE_SIZES, maxInputTokens: 32_000, maxBatch: 1000, maxBatchTokens: 1_000_000 },
  'voyage-3-large': { dimensions: 1024, matryoshka: VOYAGE_SIZES, maxInputTokens: 32_000, maxBatch: 1000, maxBatchTokens: 120_000 },
  'voyage-code-3': { dimensions: 1024, matryoshka: VOYAGE_SIZES, maxInputTokens: 32_000, maxBatch: 1000, maxBatchTokens: 120_000 },
};

/** Voyage prepends its own prompt for `query` and `document`; any other purpose sends no `input_type`. */
function inputType(purpose: Purpose | undefined): 'query' | 'document' | null {
  return purpose === 'query' || purpose === 'document' ? purpose : null;
}

/** `ubinary` is unsigned and packed MSB first, which is our binary format; signed `binary` is offset-encoded. */
const OUTPUT_DTYPE = { int8: 'int8', binary: 'ubinary' } as const;

/** `usage.total_tokens` when Voyage reports it. */
function reportedTokens(body: Readonly<Record<string, unknown>>): TokenCount {
  const usage = body['usage'];
  const total = is(usage, recordSchema) ? usage['total_tokens'] : undefined;
  return typeof total === 'number' && Number.isFinite(total) ? { basis: 'reported', count: total } : { basis: 'unknown' };
}

/** Voyage's wording for a text over the context window when `truncation` is false. Not documented, so matched loosely. */

/**
 * A Voyage model record. Voyage versions its models by name, so `assurance` is `immutable`.
 *
 * @example
 * const model = createVoyageModel({ id: 'voyage-3.5', apiKey: process.env['VOYAGE_API_KEY'] ?? '' });
 */
export function createVoyageModel(options: VoyageModelOptions) {
  const id = options.id ?? 'voyage-3.5';
  const facts = VOYAGE_FACTS[id];
  if (facts === undefined) {
    return ConfigurationFailure({ message: `voyage model ${id} is not in the facts table (${Object.keys(VOYAGE_FACTS).join(', ')})` });
  }
  if (options.apiKey === '') return ConfigurationFailure({ message: 'voyage apiKey is empty' });
  const baseURL = (options.baseURL ?? 'https://api.voyageai.com/v1').replace(/\/+$/, '');
  const send: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));

  const embedTexts = async ({ texts, purpose, dimensions, quantization, truncate, signal }: NativeRequest) => {
    let response: Response;
    try {
      response = await send(`${baseURL}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model: id,
          input: texts,
          input_type: inputType(purpose),
          // Voyage cuts silently by default; ask for an error unless the caller chose to truncate.
          truncation: truncate === true,
          ...(dimensions === undefined ? {} : { output_dimension: dimensions }),
          ...(quantization === undefined ? {} : { output_dtype: OUTPUT_DTYPE[quantization] }),
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
        return ConfigurationFailure({ message: `voyage refused the API key (${response.status})` });
      }
      if (response.status === 404) return ModelUnavailable({ model: id, reason: 'unknown-model' });
      if (response.status === 400 && mentionsContextLength(text)) return providerInputTooLong(model, texts);
      return InvalidOutput({ reason: `voyage answered ${response.status}: ${text.slice(0, 200)}` });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return signal?.aborted ? Cancelled() : InvalidOutput({ reason: 'voyage answered malformed JSON' });
    }
    const data = is(body, recordSchema) ? body['data'] : undefined;
    if (!is(body, recordSchema) || !Array.isArray(data)) {
      return InvalidOutput({ reason: 'voyage answered without a data array' });
    }
    const vectors = vectorsByIndex(data, texts.length);
    if (typeof vectors === 'string') return InvalidOutput({ reason: `voyage: ${vectors}` });
    return { vectors, tokens: reportedTokens(body) };
  };

  const model: EmbeddingModel = {
    provider: 'voyage',
    id,
    assurance: 'immutable',
    local: false,
    ...facts,
    normalized: true,
    // Voyage prepends its own prompt from `input_type`, so no text prefix here.
    instruction: NO_INSTRUCTION,
    inputs: ['text'],
    quantizations: ['int8', 'binary'],
    embedTexts,
  };
  return model;
}
