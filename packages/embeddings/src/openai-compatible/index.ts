/**
 * `@arki/embeddings/openai-compatible`: any server that speaks OpenAI's `POST /embeddings` (Nebius,
 * TEI, vLLM, LM Studio, a proxy) over plain `fetch`. No SDK and no peer, so it runs everywhere
 * `fetch` does. The server does not say what it serves, so the caller states `dimensions`.
 */
import { is, recordSchema } from '@arki/schema';

import type { FetchLike } from '../http.js';
import type { EmbeddingModel, Instruction, NativeRequest, TokenCount } from '../types.js';
import {
  Cancelled,
  ConfigurationFailure,
  InputTooLong,
  InvalidOutput,
  ModelUnavailable,
  RateLimited,
} from '../failures.js';
import { mentionsContextLength, retryAfterMs } from '../http.js';
import { NO_INSTRUCTION, QWEN3_INSTRUCTION } from '../instructions.js';

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

/**
 * Puts each row at its `index`. A row missing, repeated or out of range would attach a vector to
 * the wrong document, so any of those is an error message instead of a reordered list.
 */
function vectorsByIndex(data: readonly unknown[], count: number): readonly (readonly unknown[])[] | string {
  if (data.length !== count) return `expected ${count} rows, got ${data.length}`;
  const rows: { readonly index: number; readonly embedding: readonly unknown[] }[] = [];
  const seen = new Set<number>();
  for (const row of data) {
    const index = is(row, recordSchema) ? row['index'] : undefined;
    const embedding = is(row, recordSchema) ? row['embedding'] : undefined;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count) {
      return `row index ${String(index)} is not in 0..${count - 1}`;
    }
    if (seen.has(index)) return `row index ${index} appears twice`;
    if (!Array.isArray(embedding)) return `row ${index} has no embedding array`;
    seen.add(index);
    rows.push({ index, embedding });
  }
  // `count` distinct indices in 0..count-1: sorting by index is exactly input order.
  return rows.toSorted((left, right) => left.index - right.index).map(row => row.embedding);
}

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
 */
export function createOpenAICompatibleModel(options: OpenAICompatibleModelOptions) {
  const { id, dimensions } = options;
  const label = options.label ?? 'openai-compatible';
  if (id === '') return ConfigurationFailure({ message: `${label} needs a model id` });
  if (!/^https?:\/\//.test(options.baseURL)) {
    return ConfigurationFailure({ message: `${label} baseURL must be an http(s) URL, got "${options.baseURL}"` });
  }
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    return ConfigurationFailure({ message: `${label} dimensions must be a positive integer, got ${dimensions}` });
  }
  if (options.apiKey === '') return ConfigurationFailure({ message: `${label} apiKey is empty; omit it or set it` });

  const baseURL = options.baseURL.replace(/\/+$/, '');
  const send: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const maxInputTokens = options.maxInputTokens ?? 8192;

  const embedTexts = async ({ texts, dimensions: requested, signal }: NativeRequest) => {
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
          input: texts,
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
      if (response.status === 400 && mentionsContextLength(text)) {
        return InputTooLong({ index: 0, tokens: { basis: 'unknown' }, max: maxInputTokens });
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
