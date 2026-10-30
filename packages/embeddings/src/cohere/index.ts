/**
 * `@arki/embeddings/cohere`: Cohere over plain `fetch` (`POST /v2/embed`). No SDK and no peer, so
 * it runs on every runtime that has `fetch`. `embed-v4.0` also takes images, through the v2 `inputs` field.
 */
import { z } from 'zod';
import { isFailure } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';

import type { FetchLike } from '../http.js';
import type { EmbeddingModel, NativeInput, NativeInputsRequest, NativeRequest, Purpose, TokenCount } from '../types.js';
import { Cancelled, ConfigurationFailure, InputTooLong, InvalidOutput, ModelUnavailable, RateLimited } from '../failures.js';
import { functionSchema, parseOptions, withOptionsJson } from '../schemas.js';
import { retryAfterMs, requestSignal } from '../http.js';
import { NO_INSTRUCTION } from '../instructions.js';
import { toBase64 } from '../base64.js';
import { countTokens } from '../tokens.js';

// Cohere's 400 wording is undocumented, so this pattern stays loose: a miss turns InputTooLong (which a caller can
// split and retry) into an opaque InvalidOutput.
const TOO_LONG = /context length|context window|maximum context|too many tokens|input length|longer than|too long|exceeds? the (?:maximum|max|context)/i;

/** `InputTooLong` naming the input with the most tokens by `countTokens`: the likeliest culprit, with that count. */
function inputTooLong(model: EmbeddingModel, texts: readonly string[]) {
  let index = 0;
  let tokens: TokenCount = { basis: 'unknown' };
  for (const [position, text] of texts.entries()) {
    const counted = countTokens(model, text);
    if (counted.basis === 'unknown' || (tokens.basis !== 'unknown' && counted.count <= tokens.count)) continue;
    index = position;
    tokens = counted;
  }
  return InputTooLong({ index, tokens, max: model.maxInputTokens });
}

export type CohereModelOptions = {
  /** Default `'embed-v4.0'`. */
  readonly id?: string;
  readonly apiKey: string;
  /** Default `'https://api.cohere.com'`. */
  readonly baseURL?: string;
  readonly fetch?: FetchLike;
};

/** `CohereModelOptions`, checked by `createCohereModel`; a type test locks it to the type. */
export const cohereModelOptionsSchema = withOptionsJson(
  z
    .object({
      id: z.string().min(1).optional(),
      apiKey: z.string().min(1),
      baseURL: z.url({ protocol: /^https?$/ }).optional(),
      fetch: functionSchema<FetchLike>().optional(),
    })
    .readonly(),
);

type CohereFacts = Pick<
  EmbeddingModel,
  'dimensions' | 'matryoshka' | 'maxInputTokens' | 'maxBatch' | 'maxBatchTokens'
> & {
  /** Takes images through `inputs`. v3 models take one image per call and no text with it, so they stay text only. */
  readonly images: boolean;
};

/**
 * From https://docs.cohere.com/docs/cohere-embed (sizes, context) and /reference/embed (96 texts per
 * call). Cohere states no tokens-per-request limit, so `maxBatchTokens` is our own cap. Images:
 * https://docs.cohere.com/reference/embed (read 2026-10-22): `inputs` holds up to 96 items, each a
 * `content` array of text and `image_url` data-URI parts; v4.0 and newer take images, combined size at most 20MB.
 */
const COHERE_FACTS: Readonly<Record<string, CohereFacts>> = {
  'embed-v4.0': { dimensions: 1536, matryoshka: [1536, 1024, 512, 256], maxInputTokens: 128_000, maxBatch: 96, maxBatchTokens: 200_000, images: true },
  'embed-english-v3.0': { dimensions: 1024, matryoshka: [], maxInputTokens: 512, maxBatch: 96, maxBatchTokens: 49_152, images: false },
  'embed-multilingual-v3.0': { dimensions: 1024, matryoshka: [], maxInputTokens: 512, maxBatch: 96, maxBatchTokens: 49_152, images: false },
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

/** One input as a v2 `inputs` item: its text part, then its image as a data URI. Both parts make ONE embedding. */
function contentOf(input: NativeInput) {
  const content: (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image_url'; readonly image_url: { readonly url: string } }
  )[] = [];
  if (input.text !== undefined) content.push({ type: 'text', text: input.text });
  if (input.image !== undefined) {
    content.push({ type: 'image_url', image_url: { url: `data:${input.mimeType};base64,${toBase64(input.image)}` } });
  }
  return { content };
}

/**
 * A Cohere model record. Cohere versions its models by name, so `assurance` is `immutable`.
 *
 * @example
 * const model = createCohereModel({ id: 'embed-v4.0', apiKey: process.env['COHERE_API_KEY'] ?? '' });
 */
export function createCohereModel(input: CohereModelOptions) {
  const options = parseOptions(cohereModelOptionsSchema, input, 'cohere');
  if (isFailure(options)) return options;
  const id = options.id ?? 'embed-v4.0';
  const facts = COHERE_FACTS[id];
  if (facts === undefined) {
    return ConfigurationFailure({ message: `cohere model ${id} is not in the facts table (${Object.keys(COHERE_FACTS).join(', ')})` });
  }
  const baseURL = (options.baseURL ?? 'https://api.cohere.com').replace(/\/+$/, '');
  const send: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));

  /** One `POST /v2/embed`. `body` holds the inputs (`texts` or `inputs`); the rest is the same for both. */
  const post = async (
    body: Readonly<Record<string, unknown>>,
    { purpose, dimensions, quantization, truncate, signal }: Pick<NativeRequest, 'purpose' | 'dimensions' | 'quantization' | 'truncate' | 'signal'>,
    texts: readonly string[],
  ) => {
    const type = EMBEDDING_TYPE[quantization ?? 'float'];
    let response: Response;
    try {
      response = await send(`${baseURL}/v2/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model: id,
          ...body,
          input_type: inputType(purpose),
          embedding_types: [type],
          // Cohere cuts by default (`END`); ask for an error unless the caller chose to truncate.
          truncate: truncate === true ? 'END' : 'NONE',
          ...(dimensions === undefined ? {} : { output_dimension: dimensions }),
        }),
        signal: requestSignal(signal),
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
      if (response.status === 400 && TOO_LONG.test(text)) return inputTooLong(model, texts);
      // A server fault is worth another try: it is the same unreachable failure a dropped connection is.
      if (response.status >= 500) return ModelUnavailable({ model: id, reason: 'unreachable' });
      return InvalidOutput({ reason: `cohere answered ${response.status}: ${text.slice(0, 200)}` });
    }

    let answer: unknown;
    try {
      answer = await response.json();
    } catch {
      return signal?.aborted ? Cancelled() : InvalidOutput({ reason: 'cohere answered malformed JSON' });
    }
    const embeddings = is(answer, recordSchema) ? answer['embeddings'] : undefined;
    const vectors = is(embeddings, recordSchema) ? embeddings[type] : undefined;
    // Cohere rows carry no index: they come in input order, so the count is the only check possible here.
    if (!is(answer, recordSchema) || !Array.isArray(vectors) || !vectors.every(item => Array.isArray(item))) {
      return InvalidOutput({ reason: `cohere answered without embeddings.${type}` });
    }
    return { vectors, tokens: reportedTokens(answer) };
  };

  const embedTexts = (request: NativeRequest) => post({ texts: request.texts }, request, request.texts);

  /** Text and images in one `inputs` list: one item per input, so vectors come back in input order. */
  const embedInputs = (request: NativeInputsRequest) =>
    post({ inputs: request.inputs.map(input => contentOf(input)) }, request, request.inputs.map(input => input.text ?? ''));

  const model: EmbeddingModel = {
    provider: 'cohere',
    id,
    assurance: 'immutable',
    local: false,
    dimensions: facts.dimensions,
    matryoshka: facts.matryoshka,
    maxInputTokens: facts.maxInputTokens,
    maxBatch: facts.maxBatch,
    maxBatchTokens: facts.maxBatchTokens,
    // Cohere does not document unit-length output, so we do not claim it.
    normalized: false,
    // Cohere takes the purpose as `input_type`, so no text prefix here.
    instruction: NO_INSTRUCTION,
    inputs: facts.images ? ['text', 'image'] : ['text'],
    quantizations: ['int8', 'binary'],
    embedTexts,
    ...(facts.images ? { embedInputs } : {}),
  };
  return model;
}

export {
  cohereCompatibleRerankerOptionsSchema,
  cohereRerankerOptionsSchema,
  createCohereCompatibleReranker,
  createCohereReranker,
} from './rerank.js';
export type { CohereCompatibleRerankerOptions, CohereRerankerOptions } from './rerank.js';
