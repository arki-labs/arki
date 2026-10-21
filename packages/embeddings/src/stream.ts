import { isFailure } from '@arki/failure';

import type { EmbedFailure } from './failures.js';
import type { Embedder, Embedding, EmbeddingBatch, EmbedInput, EmbedOptions, TokenCount, Usage } from './types.js';
import { embedMany } from './embed.js';
import { InputTooLong, InvalidOutput } from './failures.js';

/** `embedStream` options: the per-call options, the text of each item, and how far ahead it may run. */
export type EmbedStreamOptions<Item> = EmbedOptions & {
  /** The input to embed for one item, e.g. `doc => doc.body`. */
  readonly text: (item: Item) => EmbedInput;
  /** Requests in flight at once. Default 2. */
  readonly concurrency?: number;
  /** Items read from the source and not yet delivered, at most. Default 64. */
  readonly maxPending?: number;
};

/** Usage of an item that shares a request with an earlier item: that item already carries the cost. */
function nothing(tokens: TokenCount): Usage {
  return {
    tokens: tokens.basis === 'unknown' ? tokens : { basis: tokens.basis, count: 0 },
    requests: 0,
    cacheHits: 0,
  };
}

/** A run of consecutive source items embedded by one `embedMany` call; `start` is the first item's position. */
type Window<Item> = {
  readonly items: readonly Item[];
  readonly start: number;
  /** Settled, never rejected: a throw is kept and rethrown when this window's turn comes. */
  readonly result: Promise<{ readonly batch: EmbeddingBatch | EmbedFailure } | { readonly thrown: unknown }>;
};

/**
 * Embeds a source of any length as a `ReadableStream` of `{ item, result }` in source order. Pull
 * based: the source is read only while the reader is reading and fewer than `maxPending` items are
 * in flight, so memory stays flat over a corpus. A failed request does not end the stream: each of
 * its items gets the failure as its `result`. The first item of a request carries that request's
 * `usage`; the others carry zero, so summing every item's usage gives the total. Cancelling the
 * stream (or aborting `signal`) aborts the requests in flight and reads no more from the source.
 * A throw from the source, `text` or a custom `embed` is a bug and errors the stream.
 *
 * @example
 * const results = embedStream(embedder, documents, { text: doc => doc.body, purpose: 'document' });
 * for await (const { item, result } of results) {
 *   if (isEmbedFailure(result)) log.warn('skipped {id}: {code}', { id: item.id, code: result.code });
 *   else await store.upsert(item.id, result.vector);
 * }
 */
export function embedStream<Item>(
  embedder: Embedder,
  source: Iterable<Item> | AsyncIterable<Item>,
  options: EmbedStreamOptions<Item>,
): ReadableStream<{ readonly item: Item; readonly result: Embedding | EmbedFailure }> {
  const { text, concurrency = 2, maxPending = 64, signal, ...embedOptions } = options;
  // NaN, Infinity, 0 or a negative count would never read: fall back to one.
  const lanes = Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : 1;
  const room = Number.isFinite(maxPending) && maxPending >= 1 ? Math.floor(maxPending) : 1;
  const width = Math.min(embedder.model.maxBatch, room);

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) controller.abort();

  let iterator: Iterator<Item> | AsyncIterator<Item> | undefined;
  const windows: Window<Item>[] = [];
  let exhausted = false;
  let pending = 0;
  let read = 0;

  /** Reads up to one request's worth of items, never past `maxPending`. */
  const gather = async (): Promise<Item[]> => {
    iterator ??= Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
    const items: Item[] = [];
    while (items.length < Math.min(width, room - pending) && !controller.signal.aborted) {
      const step = await iterator.next();
      if (step.done === true) {
        exhausted = true;
        break;
      }
      items.push(step.value);
    }
    return items;
  };

  /** Starts requests until `concurrency` are in flight, `maxPending` items are out, or the source ends. */
  const fill = async (): Promise<void> => {
    while (windows.length < lanes && pending < room && !exhausted && !controller.signal.aborted) {
      const items = await gather();
      if (items.length === 0) return;
      const result = embedMany(
        embedder,
        items.map(item => text(item)),
        { ...embedOptions, concurrency: 1, signal: controller.signal },
      ).then(
        batch => ({ batch }),
        (error: unknown) => ({ thrown: error }),
      );
      windows.push({ items, start: read, result });
      read += items.length;
      pending += items.length;
    }
  };

  const close = async (): Promise<void> => {
    signal?.removeEventListener('abort', stop);
    if (!exhausted) await iterator?.return?.();
  };

  return new ReadableStream({
    async pull(stream) {
      try {
        await fill();
        const head = windows.shift();
        if (head === undefined) {
          await close();
          stream.close();
          return;
        }
        const settled = await head.result;
        if ('thrown' in settled) throw settled.thrown;
        const { batch } = settled;
        pending -= head.items.length;
        for (const [offset, item] of head.items.entries()) {
          if (isFailure(batch)) {
            // An index from `embedMany` counts within this request; the reader's counts within the source.
            const result = InputTooLong.is(batch)
              ? InputTooLong({ ...batch.data, index: batch.data.index + head.start })
              : batch;
            stream.enqueue({ item, result });
            continue;
          }
          const vector = batch.vectors[offset];
          const usage = offset === 0 ? batch.usage : nothing(batch.usage.tokens);
          stream.enqueue({
            item,
            result:
              vector === undefined
                ? InvalidOutput({ reason: `count: expected ${head.items.length} vectors, got ${batch.vectors.length}` })
                : { vector, space: batch.space, usage },
          });
        }
      } catch (error) {
        // A throw from the source, `text` or the model must not leave requests running or the source open.
        controller.abort();
        await close();
        throw error;
      }
    },
    async cancel() {
      controller.abort();
      await close();
    },
  });
}
