/**
 * `@arki/embeddings/voyage`: Voyage AI over plain `fetch` (`POST /v1/embeddings`; the multimodal
 * models use `POST /v1/multimodalembeddings`). No SDK and no peer, so it runs on every runtime that has `fetch`.
 */
import { isFailure } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';
import { z } from 'zod';

import type { FetchLike } from '../http.js';
import type { EmbeddingModel, NativeInput, NativeInputsRequest, NativeRequest, Purpose, TokenCount } from '../types.js';
import { Cancelled, ConfigurationFailure, InputTooLong, InvalidOutput, ModelUnavailable, RateLimited } from '../failures.js';
import { functionSchema, parseOptions, withOptionsJson } from '../schemas.js';
import { retryAfterMs } from '../http.js';
import { NO_INSTRUCTION } from '../instructions.js';
import { toBase64 } from '../base64.js';

// Voyage's 400 wording is undocumented, so this pattern stays loose: a miss turns InputTooLong (which a caller can
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

const ROW_SCHEMA = z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.unknown()) }));

/**
 * Puts each row at its `index`. A row missing, repeated or out of range would attach a vector to
 * the wrong document, so any of those is an error message instead of a reordered list.
 */
function vectorsByIndex(data: unknown, count: number): readonly (readonly unknown[])[] | string {
  const parsed = ROW_SCHEMA.safeParse(data);
  if (!parsed.success) return 'a row has no integer index or no embedding array';
  const rows = parsed.data;
  if (rows.length !== count) return `expected ${count} rows, got ${rows.length}`;
  const seen = new Set<number>();
  for (const { index } of rows) {
    if (index >= count) return `row index ${index} is not in 0..${count - 1}`;
    if (seen.has(index)) return `row index ${index} appears twice`;
    seen.add(index);
  }
  // `count` distinct indices in 0..count-1: sorting by index is exactly input order.
  return [...rows].sort((left, right) => left.index - right.index).map(row => row.embedding);
}
import { countTokens } from '../tokens.js';

export type VoyageModelOptions = {
  /** Default `'voyage-3.5'`. */
  readonly id?: string;
  readonly apiKey: string;
  /** Default `'https://api.voyageai.com/v1'`. */
  readonly baseURL?: string;
  readonly fetch?: FetchLike;
};

/** `VoyageModelOptions`, checked by `createVoyageModel`; a type test locks it to the type. */
export const voyageModelOptionsSchema = withOptionsJson(
  z
    .object({
      id: z.string().min(1).optional(),
      apiKey: z.string().min(1),
      baseURL: z.url({ protocol: /^https?$/ }).optional(),
      fetch: functionSchema<FetchLike>().optional(),
    })
    .readonly(),
);

type VoyageFacts = Pick<
  EmbeddingModel,
  'dimensions' | 'matryoshka' | 'maxInputTokens' | 'maxBatch' | 'maxBatchTokens'
> & {
  /** Answers on `/multimodalembeddings` and takes image parts. The text models do not. */
  readonly multimodal: boolean;
};

/** Sizes every listed model can make besides its native 1024. */
const VOYAGE_SIZES = [2048, 1024, 512, 256] as const;

/** From https://docs.voyageai.com/docs/embeddings: 32k context, 1000 texts, tokens per request differ by model. */
const VOYAGE_FACTS: Readonly<Record<string, VoyageFacts>> = {
  'voyage-3.5': { dimensions: 1024, matryoshka: VOYAGE_SIZES, maxInputTokens: 32_000, maxBatch: 1000, maxBatchTokens: 320_000, multimodal: false },
  'voyage-3.5-lite': { dimensions: 1024, matryoshka: VOYAGE_SIZES, maxInputTokens: 32_000, maxBatch: 1000, maxBatchTokens: 1_000_000, multimodal: false },
  'voyage-3-large': { dimensions: 1024, matryoshka: VOYAGE_SIZES, maxInputTokens: 32_000, maxBatch: 1000, maxBatchTokens: 120_000, multimodal: false },
  'voyage-code-3': { dimensions: 1024, matryoshka: VOYAGE_SIZES, maxInputTokens: 32_000, maxBatch: 1000, maxBatchTokens: 120_000, multimodal: false },
  // https://docs.voyageai.com/docs/multimodal-embeddings and /reference/multimodal-embeddings-api (read
  // 2026-10-22): 32k tokens per input, 1000 inputs and 320k tokens per request, images at most 16M pixels
  // and 20 MB. Sizes other than 1024 and `output_dtype` are not documented for this endpoint, so none is
  // offered (`matryoshka: []`, no `quantizations`): the call is refused before the request.
  'voyage-multimodal-3.5': { dimensions: 1024, matryoshka: [], maxInputTokens: 32_000, maxBatch: 1000, maxBatchTokens: 320_000, multimodal: true },
  'voyage-multimodal-3': { dimensions: 1024, matryoshka: [], maxInputTokens: 32_000, maxBatch: 1000, maxBatchTokens: 320_000, multimodal: true },
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

/** One input as a multimodal `inputs` item: its text, then its image as a base64 data URI. Both parts make ONE embedding. */
function itemOf(input: NativeInput) {
  const content: (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image_base64'; readonly image_base64: string }
  )[] = [];
  if (input.text !== undefined) content.push({ type: 'text', text: input.text });
  if (input.image !== undefined) {
    content.push({ type: 'image_base64', image_base64: `data:${input.mimeType};base64,${toBase64(input.image)}` });
  }
  return { content };
}

/**
 * A Voyage model record. Voyage versions its models by name, so `assurance` is `immutable`.
 *
 * @example
 * const model = createVoyageModel({ id: 'voyage-3.5', apiKey: process.env['VOYAGE_API_KEY'] ?? '' });
 */
export function createVoyageModel(input: VoyageModelOptions) {
  const options = parseOptions(voyageModelOptionsSchema, input, 'voyage');
  if (isFailure(options)) return options;
  const id = options.id ?? 'voyage-3.5';
  const facts = VOYAGE_FACTS[id];
  if (facts === undefined) {
    return ConfigurationFailure({ message: `voyage model ${id} is not in the facts table (${Object.keys(VOYAGE_FACTS).join(', ')})` });
  }
  const baseURL = (options.baseURL ?? 'https://api.voyageai.com/v1').replace(/\/+$/, '');
  const send: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));

  /** One native call. `body` holds the inputs; the endpoint and the text options differ for the multimodal models. */
  const post = async (
    path: string,
    body: Readonly<Record<string, unknown>>,
    { purpose, dimensions, quantization, truncate, signal }: Pick<NativeRequest, 'purpose' | 'dimensions' | 'quantization' | 'truncate' | 'signal'>,
    texts: readonly string[],
  ) => {
    const count = texts.length;
    let response: Response;
    try {
      response = await send(`${baseURL}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model: id,
          ...body,
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
      if (response.status === 400 && TOO_LONG.test(text)) return inputTooLong(model, texts);
      return InvalidOutput({ reason: `voyage answered ${response.status}: ${text.slice(0, 200)}` });
    }

    let answer: unknown;
    try {
      answer = await response.json();
    } catch {
      return signal?.aborted ? Cancelled() : InvalidOutput({ reason: 'voyage answered malformed JSON' });
    }
    const data = is(answer, recordSchema) ? answer['data'] : undefined;
    if (!is(answer, recordSchema) || !Array.isArray(data)) {
      return InvalidOutput({ reason: 'voyage answered without a data array' });
    }
    const vectors = vectorsByIndex(data, count);
    if (typeof vectors === 'string') return InvalidOutput({ reason: `voyage: ${vectors}` });
    return { vectors, tokens: reportedTokens(answer) };
  };

  const embedTexts = (request: NativeRequest) =>
    facts.multimodal
      ? post(
          'multimodalembeddings',
          { inputs: request.texts.map(text => itemOf({ text })) },
          request,
          request.texts,
        )
      : post('embeddings', { input: request.texts }, request, request.texts);

  /** Text and images in one `inputs` list: one item per input, so rows come back at their input's index. */
  const embedInputs = (request: NativeInputsRequest) =>
    post('multimodalembeddings', { inputs: request.inputs.map(input => itemOf(input)) }, request, request.inputs.map(input => input.text ?? ''));

  const model: EmbeddingModel = {
    provider: 'voyage',
    id,
    assurance: 'immutable',
    local: false,
    dimensions: facts.dimensions,
    matryoshka: facts.matryoshka,
    maxInputTokens: facts.maxInputTokens,
    maxBatch: facts.maxBatch,
    maxBatchTokens: facts.maxBatchTokens,
    normalized: true,
    // Voyage prepends its own prompt from `input_type`, so no text prefix here.
    instruction: NO_INSTRUCTION,
    inputs: facts.multimodal ? ['text', 'image'] : ['text'],
    quantizations: facts.multimodal ? [] : ['int8', 'binary'],
    embedTexts,
    ...(facts.multimodal ? { embedInputs } : {}),
  };
  return model;
}

export { createVoyageReranker, voyageRerankerOptionsSchema } from './rerank.js';
export type { VoyageRerankerOptions } from './rerank.js';
