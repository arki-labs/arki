// In-process embedding: @arki/embeddings/transformers against raw Transformers.js on the same
// weights, and fastembed (another model, so `differs`).
// Run: `bun run bench bench/transformers.bench.ts` (explore). Downloads EmbeddingGemma q8 (about 316 MB)
// and BGE small (~130 MB) into TRANSFORMERS_CACHE_DIR, or into the OS temp dir when it is unset.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AutoModel, AutoTokenizer } from '@huggingface/transformers';
import { z } from 'zod';

import { compare, defineSuite, metric } from '@arki/bench';
import { createEmbedder, embedMany, isEmbedFailure } from '@arki/embeddings';
import { createTransformersModel } from '@arki/embeddings/transformers';

const MODEL = 'onnx-community/embeddinggemma-300m-ONNX';
/** The same commit `createTransformersModel` pins by default. */
const REVISION = '5090578d9565bb06545b4552f76e6bc2c93e4a66';

const CACHE = process.env['TRANSFORMERS_CACHE_DIR'] ?? path.join(tmpdir(), 'arki-embeddings-models');
const DIST = new URL('../dist/transformers/index.js', import.meta.url).href;
const FASTEMBED_DIFFERS = 'BGE small en v1.5 (384 dims): fastembed has no EmbeddingGemma';

/** Each child loads one library, embeds one text, and prints its wall time and peak RSS. */
const CHILDREN = {
  arki: (cache: string) => `
    const started = performance.now();
    const { createTransformersModel } = await import(${JSON.stringify(DIST)});
    const model = await createTransformersModel({ cacheDir: ${JSON.stringify(cache)} });
    if ('code' in model) throw new Error(model.message);`,
  raw: (cache: string) => `
    const started = performance.now();
    const { AutoModel, AutoTokenizer } = await import('@huggingface/transformers');
    const options = { revision: ${JSON.stringify(REVISION)}, cache_dir: ${JSON.stringify(cache)} };
    const tokenizer = await AutoTokenizer.from_pretrained(${JSON.stringify(MODEL)}, options);
    const model = await AutoModel.from_pretrained(${JSON.stringify(MODEL)}, { ...options, dtype: 'q8' });
    await model(tokenizer(['probe'], { padding: true, truncation: true }));`,
  fastembed: (cache: string) => `
    const started = performance.now();
    const { EmbeddingModel, FlagEmbedding } = await import('fastembed');
    const model = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir: ${JSON.stringify(cache)} });
    await model.queryEmbed('probe');`,
} as const;

type Child = keyof typeof CHILDREN;

/** The last line a child prints: its time to first vector and peak memory. */
const childReportSchema = z.object({ ms: z.number(), rssKb: z.number() });

/** The raw model's pooled output: one sentence embedding per row, flattened. */
const pooledOutputSchema = z.object({ sentence_embedding: z.object({ data: z.instanceof(Float32Array) }) });

function runChild(child: Child, cache: string): { ms: number; rssMb: number } {
  const code = `${CHILDREN[child](cache)}
    process.stdout.write(JSON.stringify({ ms: performance.now() - started, rssKb: process.resourceUsage().maxRSS }));`;
  // Bun evaluates `-e` as a module already; Node needs to be told.
  const args = process.versions.bun === undefined ? ['--input-type=module', '-e', code] : ['-e', code];
  const run = spawnSync(process.execPath, args, {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`${child} child failed: ${run.stderr}`);
  const { ms, rssKb } = childReportSchema.parse(JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}'));
  return { ms, rssMb: rssKb / 1024 };
}

/** Cold start into a fresh, empty cache: every sample downloads the weights again. */
function uncached(child: Child): number {
  const cache = mkdtempSync(path.join(tmpdir(), 'arki-embeddings-cold-'));
  try {
    return runChild(child, cache).ms;
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

const cases = <Value>(collect: (child: Child) => Value) => ({
  arki: {
    label: '@arki/embeddings createTransformersModel',
    package: '@arki/embeddings',
    collect: () => collect('arki'),
  },
  raw: {
    label: 'raw Transformers.js AutoModel + AutoTokenizer',
    package: '@huggingface/transformers',
    collect: () => collect('raw'),
  },
  fastembed: {
    label: 'fastembed FlagEmbedding.init',
    package: 'fastembed',
    differs: FASTEMBED_DIFFERS,
    collect: () => collect('fastembed'),
  },
});

// ---- Warm: one loaded session per library, the same 32 texts each sample.
const arkiModel = await createTransformersModel({ cacheDir: CACHE });
if (isEmbedFailure(arkiModel)) throw new Error(arkiModel.message);
const arki = createEmbedder(arkiModel);
if (isEmbedFailure(arki)) throw new Error(arki.message);
const rawTokenizer = await AutoTokenizer.from_pretrained(MODEL, { revision: REVISION, cache_dir: CACHE });
const rawModel = await AutoModel.from_pretrained(MODEL, { revision: REVISION, cache_dir: CACHE, dtype: 'q8' });

/** Vectors rounded to 1e-3, as one string: the two EmbeddingGemma rows must agree to that precision. */
function rounded(vectors: readonly ArrayLike<number>[]): string {
  return vectors.map(vector => Array.from(vector, value => value.toFixed(3)).join(',')).join(';');
}

function texts(set: number): string[] {
  return Array.from(
    { length: 32 },
    (_, index) => `set ${set} document ${index}: the rain in Spain stays mainly in the plain`,
  );
}

export default defineSuite({
  id: '@arki/embeddings/transformers',
  intro:
    'In-process embedding with EmbeddingGemma 300M `q8` on the CPU. `@arki/embeddings` and raw Transformers.js load the same pinned commit; fastembed has no EmbeddingGemma and runs BGE small, so its rows are shown and never ranked.',
  notes: [
    'Cold start rows run in a fresh child process: import, load, and one probe embed (which `createTransformersModel` does to learn the dimensions).',
    'The uncached cold start downloads the weights each sample, so it is network bound and collected once.',
    'Warm rows reuse one loaded session per library. `@arki/embeddings` also validates and L2-normalises each vector.',
    'fastembed has no warm row: it ships onnxruntime-node 1.21 and Transformers.js 1.30, and loading both in one process crashes (SIGSEGV). Its cold-start rows run alone in a child process.',
  ],
  groups: [
    metric({
      id: 'cold-start-cached',
      title: 'Cold start, weights already on disk (ms)',
      unit: 'ms',
      deterministic: false,
      baseline: 'arki',
      cases: cases(child => runChild(child, CACHE).ms),
    }),
    metric({
      id: 'cold-start-uncached',
      title: 'Cold start, empty cache: download included (ms, one sample)',
      unit: 'ms',
      deterministic: true,
      baseline: 'arki',
      cases: cases(uncached),
    }),
    metric({
      id: 'peak-rss',
      title: 'Peak RSS after load and one embed (MB, one sample)',
      unit: 'MB',
      deterministic: true,
      baseline: 'arki',
      cases: cases(child => runChild(child, CACHE).rssMb),
    }),
    compare<string[]>({
      id: 'warm-32',
      title: 'Warm, 32 short documents per call',
      contract: {
        id: 'transformers-warm-32/v1',
        description: 'EmbeddingGemma q8 vectors in input order, equal to 1e-3',
      },
      inputs: [texts(0), texts(1), texts(2)],
      baseline: 'arki',
      mode: 'async',
      cases: c => ({
        arki: c({
          label: '@arki/embeddings embedMany (./transformers)',
          package: '@arki/embeddings',
          run: async batch => {
            const result = await embedMany(arki, batch);
            if (isEmbedFailure(result)) throw new Error(result.message);
            return result.vectors;
          },
          normalize: vectors => rounded(vectors.map(vector => Float32Array.from(vector))),
        }),
        raw: c({
          label: 'raw Transformers.js model call',
          package: '@huggingface/transformers',
          run: async batch => {
            const output: unknown = await rawModel(rawTokenizer(batch, { padding: true, truncation: true }));
            const { data } = pooledOutputSchema.parse(output).sentence_embedding;
            return Array.from({ length: batch.length }, (_, row) => data.slice(row * 768, (row + 1) * 768));
          },
          normalize: rounded,
        }),
      }),
    }),
  ],
});
