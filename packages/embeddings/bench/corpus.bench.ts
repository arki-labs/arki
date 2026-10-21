// A 100k-document corpus through `embedStream` with a slow sink, next to `embedMany` holding it all.
// Run: `bun run bench bench/corpus.bench.ts` (explore).
//
// The fake embedder (384 dims, no network) keeps model time out, so what is measured is the
// stream's own work and, above all, how much memory a corpus costs while it is embedded.

import { defineSuite, metric } from '@arki/bench';
import { embedMany, embedStream, isEmbedFailure } from '@arki/embeddings';
import { fakeEmbedder } from '@arki/embeddings/testing';

const DOCS = 100_000;
const DIMENSIONS = 384;
/** The sink yields to the event loop every this many rows, like a database write would. */
const SINK_EVERY = 100;

type Doc = { readonly id: number; readonly body: string };

/** The corpus as a lazy source, built without a generator: documents exist only while in flight. */
function corpus(): Iterable<Doc> {
  return {
    [Symbol.iterator]: () => {
      let id = 0;
      return {
        next: () =>
          id < DOCS
            ? { done: false, value: { id, body: `document ${id++}: ${'lorem ipsum '.repeat(20)}` } }
            : { done: true, value: undefined },
      };
    },
  };
}

const embedder = fakeEmbedder({ dimensions: DIMENSIONS, seed: 1 });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Peak heap growth over a run, sampled every 50 ms, in MB. */
async function peakHeapGrowth(run: () => Promise<unknown>): Promise<number> {
  globalThis.gc?.();
  const start = process.memoryUsage().heapUsed;
  let peak = start;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }, 50);
  try {
    await run();
  } finally {
    clearInterval(sampler);
  }
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  return (peak - start) / 1024 / 1024;
}

async function streamToSlowSink(): Promise<number> {
  let written = 0;
  for await (const { result } of embedStream(embedder, corpus(), { text: doc => doc.body })) {
    if (isEmbedFailure(result)) throw new Error(result.message);
    if (++written % SINK_EVERY === 0) await tick();
  }
  return written;
}

async function embedAllThenSink(): Promise<number> {
  const docs = [...corpus()];
  const batch = await embedMany(
    embedder,
    docs.map(doc => doc.body),
  );
  if (isEmbedFailure(batch)) throw new Error(batch.message);
  let written = 0;
  for (const _vector of batch.vectors) if (++written % SINK_EVERY === 0) await tick();
  return written;
}

const timed = async (run: () => Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await run();
  return performance.now() - started;
};

const ALL_IN_MEMORY = 'holds every document and vector at once, and is all or nothing';

export default defineSuite({
  id: '@arki/embeddings/corpus',
  intro: `${DOCS.toLocaleString('en')} documents, ${DIMENSIONS}-dim fake vectors, a sink that yields every ${SINK_EVERY} rows. The stream reads the source only as fast as the sink writes.`,
  notes: [
    'Heap growth is sampled every 50 ms; the peak over the run is shown. Run with `--expose-gc` for a steadier start point.',
    '`embedMany` is the all-in-memory baseline: different behaviour (all or nothing), so it is shown and not ranked.',
  ],
  groups: [
    metric({
      id: 'corpus-heap',
      title: `Peak heap growth over ${DOCS.toLocaleString('en')} documents (MB)`,
      unit: 'MB',
      deterministic: false,
      baseline: 'stream',
      cases: {
        stream: {
          label: 'embedStream → slow sink',
          package: '@arki/embeddings',
          collect: () => peakHeapGrowth(streamToSlowSink),
        },
        all: {
          label: 'embedMany, then the sink',
          package: '@arki/embeddings',
          differs: ALL_IN_MEMORY,
          collect: () => peakHeapGrowth(embedAllThenSink),
        },
      },
    }),
    metric({
      id: 'corpus-time',
      title: `Wall time over ${DOCS.toLocaleString('en')} documents (ms)`,
      unit: 'ms',
      deterministic: false,
      baseline: 'stream',
      cases: {
        stream: {
          label: 'embedStream → slow sink',
          package: '@arki/embeddings',
          collect: () => timed(streamToSlowSink),
        },
        all: {
          label: 'embedMany, then the sink',
          package: '@arki/embeddings',
          differs: ALL_IN_MEMORY,
          collect: () => timed(embedAllThenSink),
        },
      },
    }),
  ],
});
