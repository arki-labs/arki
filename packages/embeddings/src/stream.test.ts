import { describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';

import type { EmbedFailure } from './failures.js';
import type { Embedding, NativeEmbeddings, NativeRequest } from './types.js';
import { createEmbedder } from './embedder.js';
import { Cancelled, RateLimited } from './failures.js';
import { embedStream } from './stream.js';
import { echoTexts, stubModel } from './tests/stub-model.js';

type Native = (request: NativeRequest) => Promise<NativeEmbeddings | EmbedFailure>;
type Doc = { readonly id: number };

function embedderOver(native: Native, maxBatch = 2) {
  const embedder = createEmbedder(stubModel(native, { maxBatch }));
  if (isFailure(embedder)) throw new Error('stub embedder refused its defaults');
  return embedder;
}

const docs = (count: number): Doc[] => Array.from({ length: count }, (_, id) => ({ id }));
const text = (doc: Doc): string => `t${doc.id}`;
/** The tracer vector's first value is the id + 1: it proves which text a vector came from. */
const idOf = (result: Embedding | EmbedFailure): number | undefined =>
  isFailure(result) ? undefined : (result.vector[0] ?? 0) - 1;

/** Rate limited on the request holding t4. */
const failsOnT4: Native = request =>
  request.texts.includes('t4') ? Promise.resolve(RateLimited({ retryAfterMs: 50 })) : echoTexts(request);

/** Rate limited on every request holding an id ending in 7. */
const failsOnSevens: Native = request =>
  request.texts.some(text => text.endsWith('7')) ? Promise.resolve(RateLimited({})) : echoTexts(request);

async function collect<Row>(stream: ReadableStream<Row>): Promise<Row[]> {
  const rows: Row[] = [];
  const reader = stream.getReader();
  for (let next = await reader.read(); next.done !== true; next = await reader.read()) rows.push(next.value);
  return rows;
}

/** A source that counts what was read from it, built without a generator. */
function countingSource(count: number) {
  const state = { pulled: 0, returned: false };
  const iterable: Iterable<Doc> = {
    [Symbol.iterator]: () => ({
      next: () =>
        state.pulled < count ? { done: false, value: { id: state.pulled++ } } : { done: true, value: undefined },
      return: () => {
        state.returned = true;
        return { done: true, value: undefined };
      },
    }),
  };
  return { iterable, state };
}

describe('embedStream', () => {
  // Later requests finishing first must not reorder rows: a row is written next to the wrong document otherwise.
  it('results arrive in order under concurrency', async () => {
    let calls = 0;
    const native: Native = async request => {
      const delay = 20 - (calls++ % 4) * 5;
      await new Promise(resolve => setTimeout(resolve, delay));
      return echoTexts(request);
    };
    const rows = await collect(embedStream(embedderOver(native), docs(20), { text, concurrency: 4 }));
    expect(rows.map(row => row.item.id)).toEqual(docs(20).map(doc => doc.id));
    expect(rows.map(row => idOf(row.result))).toEqual(docs(20).map(doc => doc.id));
  });

  // A corpus of any size must fit in memory: the source is read only as fast as the reader reads.
  it('backpressure stops pulling the source at maxPending (memory flat for 100k docs)', async () => {
    const { iterable, state } = countingSource(100_000);
    let read = 0;
    let ahead = 0;
    const source: Iterable<Doc> = {
      [Symbol.iterator]: () => {
        const inner = iterable[Symbol.iterator]();
        return {
          next: () => {
            ahead = Math.max(ahead, state.pulled - read);
            return inner.next();
          },
        };
      },
    };
    const reader = embedStream(embedderOver(echoTexts, 8), source, { text, maxPending: 64 }).getReader();
    for (let next = await reader.read(); next.done !== true; next = await reader.read()) read++;
    expect(read).toBe(100_000);
    expect(ahead).toBeLessThanOrEqual(64);
  });

  // One bad request must not cost the rest of a corpus: its items fail, the stream goes on.
  it('a failed chunk yields per-item failures and continues', async () => {
    const rows = await collect(embedStream(embedderOver(failsOnT4), docs(10), { text }));
    expect(rows).toHaveLength(10);
    expect(rows.filter(row => RateLimited.is(row.result)).map(row => row.item.id)).toEqual([4, 5]);
    expect(rows.filter(row => !isFailure(row.result)).map(row => idOf(row.result))).toEqual([0, 1, 2, 3, 6, 7, 8, 9]);
  });

  // A cancelled job must stop spending: requests in flight are aborted and the source is released.
  it('cancel aborts in-flight fetches and pulls no more', async () => {
    const aborted: boolean[] = [];
    const native: Native = ({ texts, signal }) =>
      texts.includes('t0')
        ? echoTexts({ texts })
        : new Promise(resolve => {
            signal?.addEventListener('abort', () => {
              aborted.push(true);
              resolve(Cancelled());
            });
          });
    const { iterable, state } = countingSource(1000);
    const reader = embedStream(embedderOver(native), iterable, { text, concurrency: 2 }).getReader();
    await reader.read();
    const pulledAtCancel = state.pulled;
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(aborted.length).toBeGreaterThan(0);
    expect(state.pulled).toBe(pulledAtCancel);
    expect(state.returned).toBe(true);
  });

  // A leaked request keeps spending money after the caller has already seen the error.
  it('a throwing source aborts in-flight requests and closes the source', async () => {
    const aborted: boolean[] = [];
    const native: Native = ({ texts, signal }) =>
      texts.includes('t0')
        ? echoTexts({ texts })
        : new Promise(resolve => {
            signal?.addEventListener('abort', () => {
              aborted.push(true);
              resolve(Cancelled());
            });
          });
    let next = 0;
    let returned = 0;
    const source: Iterable<Doc> = {
      [Symbol.iterator]: () => ({
        next: () => {
          if (next === 5) throw new Error('source broke');
          return { done: false, value: { id: next++ } };
        },
        return: () => {
          returned++;
          return { done: true, value: undefined };
        },
      }),
    };
    const caller = new AbortController();
    const removed = vi.spyOn(caller.signal, 'removeEventListener');
    const stream = embedStream(embedderOver(native), source, { text, concurrency: 2, signal: caller.signal });
    await expect(collect(stream)).rejects.toThrow('source broke');
    expect(aborted.length).toBeGreaterThan(0);
    expect(returned).toBe(1);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  // Ids are the join key back to the database: one row per id, each with its own vector or failure.
  it('no key is dropped or shifted (ids before and after match one-to-one)', async () => {
    const source = docs(53);
    const rows = await collect(
      embedStream(embedderOver(failsOnSevens, 3), source, { text, concurrency: 3, maxPending: 7 }),
    );
    expect(rows.map(row => row.item.id)).toEqual(source.map(doc => doc.id));
    for (const row of rows) {
      if (!isFailure(row.result)) expect(idOf(row.result)).toBe(row.item.id);
    }
  });

  // Totals come from summing per-item usage, so a request's cost must be counted exactly once.
  it('the first item of each request carries its usage', async () => {
    const rows = await collect(embedStream(embedderOver(echoTexts, 4), docs(10), { text }));
    const usages = rows.flatMap(row => (isFailure(row.result) ? [] : [row.result.usage]));
    expect(usages.reduce((sum, usage) => sum + usage.requests, 0)).toBe(3);
    const tokens = usages.reduce((sum, usage) => sum + (usage.tokens.basis === 'unknown' ? 0 : usage.tokens.count), 0);
    expect(tokens).toBe(10);
  });
});
