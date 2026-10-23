import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { assert } from '@arki/schema';

import type { EmbedFailure } from './failures.js';
import type { EmbedInput, EmbedOptions, Embedder, Embedding, EmbeddingBatch, Usage } from './types.js';
import { Cancelled, InputTooLong, InvalidOutput } from './failures.js';
import { pack } from './pack.js';
import { embedOptionsFields, embedOptionsSchema, functionSchema, withOptionsJson } from './schemas.js';
import { addTokens } from './tokens.js';

/** `embedMany` options: the per-call options plus how many chunks run at once and a progress callback. */
export type EmbedManyOptions = EmbedOptions & {
  readonly concurrency?: number;
  readonly onProgress?: (done: number, total: number, usage: Usage) => void;
};

/** `EmbedManyOptions`, checked by `embedMany`; a type test locks it to the type. */
export const embedManyOptionsSchema = withOptionsJson(
  embedOptionsFields
    .extend({
      concurrency: z.number().int().positive().optional(),
      onProgress: functionSchema<NonNullable<EmbedManyOptions['onProgress']>>().optional(),
    })
    .readonly(),
);

function addUsage(a: Usage, b: Usage): Usage {
  const loadMs = a.loadMs === undefined && b.loadMs === undefined ? undefined : (a.loadMs ?? 0) + (b.loadMs ?? 0);
  return {
    tokens: addTokens(a.tokens, b.tokens),
    requests: a.requests + b.requests,
    cacheHits: a.cacheHits + b.cacheHits,
    ...(loadMs === undefined ? {} : { loadMs }),
  };
}

const NO_USAGE: Usage = { tokens: { basis: 'counted', count: 0 }, requests: 0, cacheHits: 0 };

/**
 * Embeds any number of inputs: packs them by `maxBatch` and `maxBatchTokens`, runs the chunks with
 * bounded concurrency and reassembles vectors in input order. All or nothing: the first failure
 * cancels the remaining chunks, waits for the ones in flight, and is returned with no vectors.
 *
 * @example
 * const batch = await embedMany(embedder, texts, { purpose: 'document', concurrency: 4 });
 * if (isFailure(batch)) return batch;
 */
export async function embedMany(
  embedder: Embedder,
  inputs: readonly EmbedInput[],
  options: EmbedManyOptions = {},
): Promise<EmbeddingBatch | EmbedFailure> {
  assert(options, embedManyOptionsSchema, { at: 'embedMany options' });
  return embedChunks(embedder, inputs, options);
}

/** `embedMany` after its options check, for callers that already checked theirs (`embed`, `embedStream`). */
export async function embedChunks(
  embedder: Embedder,
  inputs: readonly EmbedInput[],
  options: EmbedManyOptions,
): Promise<EmbeddingBatch | EmbedFailure> {
  const { concurrency = 2, onProgress, signal, ...embedOptions } = options;
  if (signal?.aborted) return Cancelled();
  if (inputs.length === 0) return { vectors: [], space: embedder.space, usage: NO_USAGE };

  const chunks = pack(embedder.model, inputs, embedOptions.onTooLong === 'truncate');
  if (isFailure(chunks)) return chunks;

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });

  // Filled by index as chunks finish; complete exactly when every chunk succeeded.
  const vectors: EmbeddingBatch['vectors'][number][] = [];
  let failure: EmbedFailure | undefined;
  // Starts from the first chunk's usage: a zero seed would carry its own basis into the result.
  let usage: Usage | undefined;
  let space = embedder.space;
  let done = 0;
  let next = 0;

  // A throw from a custom `embed` or `onProgress` is a bug, not a failure value: it stops the
  // siblings and is rethrown once they have all settled.
  let thrown: { readonly error: unknown } | undefined;

  const worker = async (): Promise<void> => {
    try {
      while (failure === undefined && !controller.signal.aborted && next < chunks.length) {
        const chunk = chunks[next++];
        if (chunk === undefined) return;
        const batch = await embedder.embed(inputs.slice(chunk.start, chunk.end), {
          ...embedOptions,
          signal: controller.signal,
        });
        if (isFailure(batch)) {
          // An index from `embed` counts within the chunk; the caller's counts within `inputs`.
          failure ??= InputTooLong.is(batch)
            ? InputTooLong({ ...batch.data, index: batch.data.index + chunk.start })
            : batch;
          controller.abort();
          return;
        }
        if (batch.vectors.length !== chunk.end - chunk.start) {
          failure ??= InvalidOutput({
            reason: `count: expected ${chunk.end - chunk.start} vectors, got ${batch.vectors.length}`,
          });
          controller.abort();
          return;
        }
        for (const [offset, vector] of batch.vectors.entries()) vectors[chunk.start + offset] = vector;
        usage = usage === undefined ? batch.usage : addUsage(usage, batch.usage);
        space = batch.space;
        done += chunk.end - chunk.start;
        onProgress?.(done, inputs.length, usage);
      }
    } catch (error) {
      thrown ??= { error };
      controller.abort();
    }
  };

  try {
    // Workers never reject, so this waits for every chunk in flight.
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  } finally {
    signal?.removeEventListener('abort', stop);
  }

  if (thrown !== undefined) throw thrown.error;
  if (failure !== undefined) return failure;
  if (signal?.aborted) return Cancelled();
  if (done !== inputs.length) return InvalidOutput({ reason: `count: expected ${inputs.length} vectors, got ${done}` });
  return { vectors, space, usage: usage ?? NO_USAGE };
}

/**
 * Embeds one input. Same validation and failures as `embedMany`.
 *
 * @example
 * const query = await embed(embedder, 'refund policy', { purpose: 'query' });
 */
export async function embed(
  embedder: Embedder,
  input: EmbedInput,
  options: EmbedOptions = {},
): Promise<Embedding | EmbedFailure> {
  assert(options, embedOptionsSchema, { at: 'embed options' });
  const batch = await embedChunks(embedder, [input], options);
  if (isFailure(batch)) return batch;
  const vector = batch.vectors[0];
  if (vector === undefined) return InvalidOutput({ reason: 'count: expected 1 vector, got 0' });
  return { vector, space: batch.space, usage: batch.usage };
}
