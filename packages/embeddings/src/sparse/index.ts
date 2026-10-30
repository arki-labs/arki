/**
 * `@arki/embeddings/sparse`: sparse (SPLADE) vectors from a Text Embeddings Inference server's
 * `POST /embed_sparse` over plain `fetch` (TEI started with `--pooling splade` on a BERT or
 * DistilBERT masked-LM). A sparse vector weights tokens of one tokenizer's vocabulary, so the
 * vocabulary is part of its space: vectors from two vocabularies are never compared. BGE-M3 sparse
 * goes through the same endpoint once TEI serves it.
 */
import { z } from 'zod';

import { getLogger } from '@arki/log';
import { isFailure } from '@arki/failure';
import { assert } from '@arki/schema';

import type { EmbedFailure } from '../failures.js';
import type { FetchLike } from '../http.js';
import type { EmbeddingsLogger, EmbeddingSpace, TokenCount, Usage } from '../types.js';
import {
  Cancelled,
  ConfigurationFailure,
  InputTooLong,
  InvalidOutput,
  ModelUnavailable,
  RateLimited,
  SpaceMismatch,
  UnsupportedInput,
} from '../failures.js';
import { retryAfterMs, requestSignal } from '../http.js';
import { NO_INSTRUCTION } from '../instructions.js';
import { objectSchema, functionSchema, parseOptions, withOptionsJson } from '../schemas.js';
import { isSameSpace, spaceId } from '../space.js';
import { CHARS_PER_TOKEN } from '../tokens.js';

/**
 * The space of a sparse vector: `dimensions` is the vocabulary size and `vocabulary` names the
 * tokenizer its indices point into. Held once per batch and per index, not on every vector.
 */
export type SparseSpace = EmbeddingSpace & {
  /** The tokenizer vocabulary, e.g. `'naver/splade-v3'`. Index 2054 is a different token in another vocabulary. */
  readonly vocabulary: string;
};

/** Token weights: `indices` ascending and unique, `values[i]` the weight of token `indices[i]`. */
export type SparseVector = { readonly indices: Uint32Array; readonly values: Float32Array };

export type SparseBatch = {
  readonly vectors: readonly SparseVector[];
  readonly space: SparseSpace;
  readonly usage: Usage;
};

export type SparseEmbedOptions = {
  /** An input longer than the server accepts: `'fail'` (default) returns `InputTooLong`; `'truncate'` lets TEI cut it. */
  readonly onTooLong?: 'fail' | 'truncate';
  readonly signal?: AbortSignal;
};

/** `SparseEmbedOptions`, checked by the embedder's `embed`; a type test locks it to the type. */
export const sparseEmbedOptionsSchema = withOptionsJson(
  z.object({ onTooLong: z.enum(['fail', 'truncate']).optional(), signal: objectSchema<AbortSignal>().optional() }).readonly(),
);

/** A sparse model with its server fixed. `embed` is one request of at most `maxBatch` texts, no retry. */
export type SparseEmbedder = {
  readonly id: string;
  readonly space: SparseSpace;
  readonly maxBatch: number;
  readonly maxInputTokens: number;
  embed(texts: readonly string[], options: SparseEmbedOptions): Promise<SparseBatch | EmbedFailure>;
};

export type SparseModelOptions = {
  /** The model TEI serves, e.g. `'naver/splade-v3'`. */
  readonly id: string;
  /** The TEI server root, e.g. `'http://127.0.0.1:8080'`. */
  readonly baseURL: string;
  /** Sent as `Authorization: Bearer <apiKey>`. Local servers need none. */
  readonly apiKey?: string;
  /** HF commit the server runs; part of the space. */
  readonly revision?: string;
  /** Vocabulary size: 30522 for BERT-based SPLADE. Every index must be below it. */
  readonly dimensions: number;
  /** Default: `id`. Set it when the tokenizer is not the model's own. */
  readonly vocabulary?: string;
  /** TEI `--max-client-batch-size`. Default 32. */
  readonly maxBatch?: number;
  /** TEI `max_input_length`. Default 512. */
  readonly maxInputTokens?: number;
  readonly fetch?: FetchLike;
  readonly log?: EmbeddingsLogger;
};

/** `SparseModelOptions`, checked by `createSparseModel`; a type test locks it to the type. */
export const sparseModelOptionsSchema = withOptionsJson(
  z
    .object({
      id: z.string().min(1),
      baseURL: z.url({ protocol: /^https?$/ }),
      apiKey: z.string().min(1).optional(),
      revision: z.string().min(1).optional(),
      dimensions: z.number().int().positive(),
      vocabulary: z.string().min(1).optional(),
      maxBatch: z.number().int().positive().optional(),
      maxInputTokens: z.number().int().positive().optional(),
      fetch: functionSchema<FetchLike>().optional(),
      log: objectSchema<EmbeddingsLogger>().optional(),
    })
    .readonly(),
);

/** `/embed_sparse` answers one list of `{ index, value }` per input, in input order. */
const sparseResponseSchema = z.array(z.array(z.object({ index: z.number().int().nonnegative(), value: z.number() })));
/** TEI's error body. */
const errorBodySchema = z.object({ error: z.string(), error_type: z.string() });
/** TEI's `x-compute-tokens` header: the tokens the request cost. */
const computeTokensSchema = z.coerce.number().int().nonnegative();

/** The space as one readable string: the dense {@link spaceId} plus `/v:<vocabulary>`. */
export function sparseSpaceId(space: SparseSpace): string {
  return `${spaceId(space)}/v:${space.vocabulary}`;
}

/** True when sparse vectors from `a` and `b` are comparable: same space and same vocabulary. */
export function isSameSparseSpace(a: SparseSpace, b: SparseSpace): boolean {
  return a.vocabulary === b.vocabulary && isSameSpace(a, b);
}

/**
 * `SpaceMismatch` when `actual` is not the space an index was built in, else `undefined`.
 *
 * @example
 * const mismatch = requireSparseSpace(storedSpace, sparse.space);
 * if (mismatch) return mismatch;
 */
export function requireSparseSpace(expected: SparseSpace, actual: SparseSpace): SpaceMismatch | undefined {
  return isSameSparseSpace(expected, actual) ? undefined : SpaceMismatch({ expected, actual });
}

/**
 * Sorts one TEI row into a sparse vector. A repeated index, an index outside the vocabulary or a
 * weight float32 cannot hold would score the wrong tokens, so each is an error message instead.
 */
function toSparseVector(
  row: readonly { readonly index: number; readonly value: number }[],
  size: number,
): SparseVector | string {
  const sorted = [...row].sort((left, right) => left.index - right.index);
  const indices = new Uint32Array(sorted.length);
  const values = new Float32Array(sorted.length);
  for (const [position, { index, value }] of sorted.entries()) {
    if (index >= size) return `index ${index} is outside the vocabulary of ${size}`;
    if (position > 0 && sorted[position - 1]?.index === index) return `index ${index} appears twice`;
    if (!Number.isFinite(Math.fround(value))) return `index ${index} has a weight float32 cannot hold`;
    indices[position] = index;
    values[position] = value;
  }
  return { indices, values };
}

/** The longest text as `InputTooLong`: TEI names neither the input nor its count. */
function inputTooLong(texts: readonly string[], max: number) {
  const lengths = texts.map(text => text.length);
  const index = lengths.indexOf(Math.max(...lengths));
  return InputTooLong({
    index,
    tokens: { basis: 'estimated', count: Math.ceil((lengths[index] ?? 0) / CHARS_PER_TOKEN) },
    max,
  });
}

/**
 * A sparse embedder over TEI's `/embed_sparse`. The operator decides what the server runs, so
 * state `dimensions` (the vocabulary size) and, to pin it, `revision`.
 *
 * @example
 * // Apache-2.0, multilingual; TEI: --model-id opensearch-project/opensearch-neural-sparse-encoding-multilingual-v1 --pooling splade
 * const splade = createSparseModel({
 *   id: 'opensearch-project/opensearch-neural-sparse-encoding-multilingual-v1',
 *   baseURL: 'http://127.0.0.1:8080',
 *   dimensions: 105_879,
 * });
 * if (isFailure(splade)) throw new Error(splade.message);
 * const batch = await splade.embed(['what is a sparse vector?'], {});
 */
export function createSparseModel(input: SparseModelOptions): SparseEmbedder | ConfigurationFailure {
  const options = parseOptions(sparseModelOptionsSchema, input, 'sparse');
  if (isFailure(options)) return options;
  const { id, dimensions } = options;

  const baseURL = options.baseURL.replace(/\/+$/, '');
  const send: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const maxBatch = options.maxBatch ?? 32;
  const maxInputTokens = options.maxInputTokens ?? 512;
  const space: SparseSpace = {
    provider: 'tei',
    model: id,
    ...(options.revision === undefined ? {} : { revision: options.revision }),
    dimensions,
    // SPLADE weights are log-saturated activations, not unit-length.
    normalized: false,
    quantization: 'float32',
    instructionVersion: NO_INSTRUCTION.version,
    vocabulary: options.vocabulary ?? id,
  };
  const log = options.log ?? getLogger('arki:embeddings');
  log.debug('sparse embedder created for {model} with vocabulary {vocabulary}', {
    model: id,
    vocabulary: space.vocabulary,
  });

  const embed: SparseEmbedder['embed'] = async (texts, callOptions) => {
    assert(callOptions, sparseEmbedOptionsSchema, { at: 'sparse embed options' });
    const { onTooLong, signal } = callOptions;
    if (signal?.aborted) return Cancelled();
    if (texts.length > maxBatch) return UnsupportedInput({ index: maxBatch, part: 'batch' });
    if (texts.length === 0)
      return { vectors: [], space, usage: { tokens: { basis: 'reported', count: 0 }, requests: 0, cacheHits: 0 } };

    let response: Response;
    try {
      response = await send(`${baseURL}/embed_sparse`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
        },
        // Sent either way: a server started with `--auto-truncate` would otherwise cut silently.
        body: JSON.stringify({ inputs: texts, truncate: onTooLong === 'truncate' }),
        signal: requestSignal(signal),
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
      const body = errorBodySchema.safeParse(parsed);
      const message = body.success ? body.data.error : text.slice(0, 200);
      if (response.status === 429) {
        const wait = retryAfterMs(name => response.headers.get(name));
        return RateLimited(wait === undefined ? {} : { retryAfterMs: wait });
      }
      if (response.status === 401 || response.status === 403) {
        return ConfigurationFailure({ message: `sparse server refused the API key (${response.status})` });
      }
      if (response.status === 404) return ModelUnavailable({ model: id, reason: 'unknown-model' });
      if (response.status === 503) return ModelUnavailable({ model: id, reason: 'unreachable' });
      // TEI: "`inputs` must have less than 512 tokens. Given: 600" (422, Validation).
      if (/must have less than \d+ (?:tokens|characters)/.test(message)) {
        return inputTooLong(texts, maxInputTokens);
      }
      if (/batch size/.test(message)) return UnsupportedInput({ index: -1, part: 'batch' });
      // A server fault is worth another try: it is the same unreachable failure a dropped connection is.
      if (response.status >= 500) return ModelUnavailable({ model: id, reason: 'unreachable' });
      return InvalidOutput({ reason: `sparse server answered ${response.status}: ${message.slice(0, 200)}` });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return signal?.aborted ? Cancelled() : InvalidOutput({ reason: 'sparse server answered malformed JSON' });
    }
    const rows = sparseResponseSchema.safeParse(json);
    if (!rows.success)
      return InvalidOutput({
        reason: `sparse server answered an unexpected shape: ${rows.error.message.slice(0, 200)}`,
      });
    if (rows.data.length !== texts.length) {
      return InvalidOutput({ reason: `sparse server answered ${rows.data.length} rows for ${texts.length} inputs` });
    }
    const vectors: SparseVector[] = [];
    for (const [position, row] of rows.data.entries()) {
      const vector = toSparseVector(row, dimensions);
      if (typeof vector === 'string') return InvalidOutput({ reason: `sparse row ${position}: ${vector}` });
      vectors.push(vector);
    }
    const counted = computeTokensSchema.safeParse(response.headers.get('x-compute-tokens') ?? undefined);
    const tokens: TokenCount = counted.success ? { basis: 'reported', count: counted.data } : { basis: 'unknown' };
    return { vectors, space, usage: { tokens, requests: 1, cacheHits: 0 } };
  };

  return { id, space, maxBatch, maxInputTokens, embed };
}
