/**
 * `@arki/embeddings/openai-compatible`: any server that speaks OpenAI's `POST /embeddings` (Nebius,
 * TEI, vLLM, LM Studio, a proxy) over plain `fetch`. No SDK and no peer, so it runs everywhere
 * `fetch` does. The server does not say what it serves, so the caller states `dimensions`.
 */
import { isFailure } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';
import { z } from 'zod';

import type { FetchLike } from '../http.js';
import type { EmbeddingModel, Instruction, NativeRequest, TokenCount } from '../types.js';
import { Cancelled, ConfigurationFailure, InputTooLong, InvalidOutput, ModelUnavailable, RateLimited } from '../failures.js';
import { functionSchema, instructionSchema, parseOptions, withOptionsJson } from '../schemas.js';
import { retryAfterMs } from '../http.js';
import { NO_INSTRUCTION, QWEN3_INSTRUCTION } from '../instructions.js';

// A compatible server's 400 wording is undocumented, so this pattern stays loose: a miss turns InputTooLong (which a caller can
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
import { countTokens, truncateByEstimate } from '../tokens.js';

export type OpenAICompatibleModelOptions = {
  /** The model name the server expects, e.g. `'Qwen/Qwen3-Embedding-8B'`. */
  readonly id: string;
  /** Up to and including the version segment, e.g. `'https://api.tokenfactory.nebius.com/v1'`. */
  readonly baseURL: string;
  /** Sent as `Authorization: Bearer <apiKey>`. Local servers often need none. */
  readonly apiKey?: string;
  /** The model's native output size. */
  readonly dimensions: number;
  /** Inputs per request. Default 256. */
  readonly maxBatch?: number;
  /** Tokens per request. Default 300 000. */
  readonly maxBatchTokens?: number;
  /** Default 8192. */
  readonly maxInputTokens?: number;
  /** Whether the server answers unit-length vectors. Default `true`. */
  readonly normalized?: boolean;
  /** Default: `QWEN3_INSTRUCTION` for a Qwen3-Embedding id, else no prefix. */
  readonly instruction?: Instruction;
  /** Names the server in failure messages, e.g. `'nebius'`. Default `'openai-compatible'`. */
  readonly label?: string;
  readonly fetch?: FetchLike;
};

/** `OpenAICompatibleModelOptions`, checked by `createOpenAICompatibleModel`; a type test locks it to the type. */
export const openaiCompatibleModelOptionsSchema = withOptionsJson(
  z
    .object({
      id: z.string().min(1),
      baseURL: z.url({ protocol: /^https?$/ }),
      apiKey: z.string().min(1).optional(),
      dimensions: z.number().int().positive(),
      maxBatch: z.number().int().positive().optional(),
      maxBatchTokens: z.number().int().positive().optional(),
      maxInputTokens: z.number().int().positive().optional(),
      normalized: z.boolean().optional(),
      instruction: instructionSchema.optional(),
      label: z.string().min(1).optional(),
      fetch: functionSchema<FetchLike>().optional(),
    })
    .readonly(),
);

/** `usage.prompt_tokens` when the server reports it. */
function reportedTokens(body: Readonly<Record<string, unknown>>): TokenCount {
  const usage = body['usage'];
  const prompt = is(usage, recordSchema) ? usage['prompt_tokens'] : undefined;
  return typeof prompt === 'number' && Number.isFinite(prompt)
    ? { basis: 'reported', count: prompt }
    : { basis: 'unknown' };
}

/**
 * A model record for an OpenAI-compatible server. The operator decides what the id serves, so
 * `assurance` is `operator-pinned`.
 *
 * @example
 * const model = createOpenAICompatibleModel({ id: 'Qwen/Qwen3-Embedding-8B', baseURL: 'https://api.example.com/v1', dimensions: 4096 });
 */
export function createOpenAICompatibleModel(input: OpenAICompatibleModelOptions) {
  const options = parseOptions(openaiCompatibleModelOptionsSchema, input, 'openai-compatible');
  if (isFailure(options)) return options;
  const { id, dimensions } = options;
  const label = options.label ?? 'openai-compatible';

  const baseURL = options.baseURL.replace(/\/+$/, '');
  const send: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const maxInputTokens = options.maxInputTokens ?? 8192;

  const embedTexts = async ({ texts, dimensions: requested, truncate, signal }: NativeRequest) => {
    let response: Response;
    try {
      response = await send(`${baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
        },
        body: JSON.stringify({
          model: id,
          // The protocol has no truncate flag: cut at the character estimate of the model's limit.
          input: truncate ? texts.map(text => truncateByEstimate(text, maxInputTokens)) : texts,
          ...(requested === undefined ? {} : { dimensions: requested }),
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
        return ConfigurationFailure({ message: `${label} refused the API key (${response.status})` });
      }
      if (response.status === 404) return ModelUnavailable({ model: id, reason: 'unknown-model' });
      if (response.status === 400 && TOO_LONG.test(text)) {
        return inputTooLong(model, texts);
      }
      return InvalidOutput({ reason: `${label} answered ${response.status}: ${text.slice(0, 200)}` });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return signal?.aborted ? Cancelled() : InvalidOutput({ reason: `${label} answered malformed JSON` });
    }
    const data = is(body, recordSchema) ? body['data'] : undefined;
    if (!is(body, recordSchema) || !Array.isArray(data)) {
      return InvalidOutput({ reason: `${label} answered without a data array` });
    }
    const vectors = vectorsByIndex(data, texts.length);
    if (typeof vectors === 'string') return InvalidOutput({ reason: `${label}: ${vectors}` });
    return { vectors, tokens: reportedTokens(body) };
  };

  const model: EmbeddingModel = {
    provider: 'openai-compatible',
    id,
    assurance: 'operator-pinned',
    local: false,
    dimensions,
    matryoshka: [],
    maxInputTokens,
    maxBatch: options.maxBatch ?? 256,
    maxBatchTokens: options.maxBatchTokens ?? 300_000,
    normalized: options.normalized ?? true,
    instruction: options.instruction ?? (/qwen3-embedding/i.test(id) ? QWEN3_INSTRUCTION : NO_INSTRUCTION),
    inputs: ['text'],
    quantizations: [],
    embedTexts,
  };
  return model;
}
