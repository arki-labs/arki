// Rerank quality: nDCG@10 and MRR@10 of the same first-stage top 50, before and after each
// reranker, on a fixed slice of test queries from SciFact, NFCorpus and FiQA (BEIR), plus any folder
// in the BEIR shape passed with `--dataset` (fleet/embeddings-eval/ro-retrieval-v1 once its queries
// are graded). The first stage is the local default embedder, Ollama qwen3-embedding:0.6b, and its
// top 50 per query is cached in `.cache/rerank-first-stage/`, so every reranker reads the same list.
//
// Run from packages/embeddings: `bun run eval:rerank [--rerankers a,b] [--queries 100] [--on-too-long truncate|split]`.
// The quality numbers do not move with machine load. The milliseconds per query do: they are printed
// as an order of magnitude only; `rerank.bench.ts` is the timing.
//
// Hosted rows run only when their key is set; TEI and Cohere-compatible rows only with a server URL.
// A row that does not run is printed as not run, never dropped.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

import type { Reranker } from '@arki/embeddings/rerank';
import { createEmbedder, embedMany, isEmbedFailure, l2Normalize, spaceId } from '@arki/embeddings';
import { createCohereCompatibleReranker, createCohereReranker } from '@arki/embeddings/cohere';
import { createJinaReranker } from '@arki/embeddings/jina';
import { createOllamaModel } from '@arki/embeddings/ollama';
import { rerank } from '@arki/embeddings/rerank';
import { createTeiReranker } from '@arki/embeddings/tei';
import { createTransformersReranker } from '@arki/embeddings/transformers';
import { createVoyageReranker } from '@arki/embeddings/voyage';

import type { RetrievalSet } from './beir.js';
import type { GroupScores } from './retrieval.js';
import { loadRetrievalSet } from './beir.js';
import { ensureDataset } from './datasets.js';
import { scoreGroup, searchDense } from './retrieval.js';

const OLLAMA = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
const MODEL_CACHE = process.env['TRANSFORMERS_CACHE_DIR'] ?? path.join(tmpdir(), 'arki-embeddings-models');
const ROOT = path.join(import.meta.dirname, '..', '..', '.cache');
/** How many first-stage hits each reranker reorders. */
const DEPTH = 50;

const { values: args } = parseArgs({
  options: {
    rerankers: { type: 'string' },
    dataset: { type: 'string', multiple: true },
    /** Test queries per set, the first N by id: the same slice for every reranker. */
    queries: { type: 'string', default: '100' },
    'on-too-long': { type: 'string', default: 'truncate' },
    'tei-url': { type: 'string' },
    'tei-model': { type: 'string', default: 'BAAI/bge-reranker-v2-m3' },
    'compatible-url': { type: 'string' },
    'compatible-model': { type: 'string', default: 'BAAI/bge-reranker-v2-m3' },
  },
});
const sliceSize = z.coerce.number().int().positive().parse(args.queries);
const onTooLong = z.enum(['truncate', 'split']).parse(args['on-too-long']);

type Candidate = {
  readonly key: string;
  readonly label: string;
  /** Why the row cannot run here, when it cannot. */
  readonly missing?: string;
  readonly build: () => Promise<Reranker | { readonly message: string }>;
};

const keyed = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};
const needsKey = (name: string) => (keyed(name) === undefined ? { missing: `${name} not set` } : {});

const CANDIDATES: readonly Candidate[] = [
  {
    key: 'bge-m3',
    label: 'bge-reranker-v2-m3 q8, Transformers.js (in-process default)',
    build: () => createTransformersReranker({ cacheDir: MODEL_CACHE }),
  },
  {
    key: 'qwen3-0.6b',
    label: 'Qwen3-Reranker-0.6B q8, Transformers.js',
    build: () => createTransformersReranker({ id: 'onnx-community/Qwen3-Reranker-0.6B-ONNX', cacheDir: MODEL_CACHE }),
  },
  {
    key: 'cohere-3.5',
    label: 'Cohere rerank-v3.5 (hosted)',
    ...needsKey('COHERE_API_KEY'),
    build: () => Promise.resolve(createCohereReranker({ apiKey: keyed('COHERE_API_KEY') ?? '' })),
  },
  {
    key: 'voyage-2.5',
    label: 'Voyage rerank-2.5 (hosted)',
    ...needsKey('VOYAGE_API_KEY'),
    build: () => Promise.resolve(createVoyageReranker({ apiKey: keyed('VOYAGE_API_KEY') ?? '' })),
  },
  {
    key: 'voyage-2.5-lite',
    label: 'Voyage rerank-2.5-lite (hosted)',
    ...needsKey('VOYAGE_API_KEY'),
    build: () =>
      Promise.resolve(createVoyageReranker({ apiKey: keyed('VOYAGE_API_KEY') ?? '', id: 'rerank-2.5-lite' })),
  },
  {
    key: 'jina-v2',
    label: 'Jina jina-reranker-v2-base-multilingual (hosted)',
    ...needsKey('JINA_API_KEY'),
    build: () => Promise.resolve(createJinaReranker({ apiKey: keyed('JINA_API_KEY') ?? '' })),
  },
  {
    key: 'tei',
    label: `${args['tei-model']} on TEI`,
    ...(args['tei-url'] === undefined ? { missing: '--tei-url not given' } : {}),
    build: () =>
      Promise.resolve(
        createTeiReranker({ id: args['tei-model'], baseURL: args['tei-url'] ?? '', maxInputTokens: 1024 }),
      ),
  },
  {
    key: 'compatible',
    label: `${args['compatible-model']} on a Cohere-compatible server (Infinity, vLLM)`,
    ...(args['compatible-url'] === undefined ? { missing: '--compatible-url not given' } : {}),
    build: () =>
      Promise.resolve(
        createCohereCompatibleReranker({
          id: args['compatible-model'],
          baseURL: args['compatible-url'] ?? '',
          maxInputTokens: 1024,
        }),
      ),
  },
];

const progress = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** Query id → first-stage passage ids, best first. */
const firstStageSchema = z.object({
  space: z.string(),
  rankings: z.record(z.string(), z.array(z.string())),
});

/** The local default embedder's top `DEPTH` for every query, from cache when the space matches. */
async function firstStage(set: RetrievalSet): Promise<ReadonlyMap<string, readonly string[]>> {
  const model = createOllamaModel({ id: 'qwen3-embedding:0.6b', baseURL: OLLAMA });
  if (isEmbedFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(model);
  if (isEmbedFailure(embedder)) throw new Error(embedder.message);
  const file = path.join(ROOT, 'rerank-first-stage', `${set.name}.json`);
  const cached = await readFile(file, 'utf8').then(
    text => firstStageSchema.safeParse(JSON.parse(text)),
    // No cache file yet: computed below.
    () => null,
  );
  // The digest is learned on the first call, so the cache is checked against the space after one.
  const probe = await embedMany(embedder, ['probe'], { purpose: 'query' });
  if (isEmbedFailure(probe)) throw new Error(`first stage: ${probe.message}`);
  const space = spaceId(probe.space);
  if (cached?.success === true && cached.data.space === space) return new Map(Object.entries(cached.data.rankings));

  const embed = async (texts: readonly string[], purpose: 'query' | 'document', what: string) => {
    const batch = await embedMany(embedder, texts, {
      purpose,
      onTooLong: 'truncate',
      concurrency: 2,
      onProgress: (done, total) => {
        if (done === total || done % 4096 < 32) progress(`  ${set.name} ${what}: ${done}/${total}`);
      },
    });
    if (isEmbedFailure(batch)) throw new Error(`${set.name} ${what}: ${batch.message}`);
    return batch.vectors.map(vector => {
      if (!(vector instanceof Float32Array)) throw new Error('expected float32 vectors');
      return l2Normalize(vector);
    });
  };
  const docs = await embed(
    set.corpus.map(passage => passage.text),
    'document',
    'corpus',
  );
  const queries = await embed(
    set.queries.map(query => query.text),
    'query',
    'queries',
  );
  const ranked = searchDense(
    set.corpus.map(passage => passage.id),
    docs,
    queries,
    DEPTH,
  );
  const rankings = Object.fromEntries(set.queries.map((query, index) => [query.id, ranked[index] ?? []]));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ space, rankings }));
  return new Map(Object.entries(rankings));
}

type Row = {
  readonly set: string;
  readonly reranker: string;
  readonly dense: GroupScores;
  readonly reranked?: GroupScores;
  readonly msPerQuery?: { readonly p50: number; readonly p95: number };
  readonly note?: string;
};

const percentile = (values: readonly number[], share: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? Number.NaN;
};

async function runSet(set: RetrievalSet, rerankers: ReadonlyMap<string, Reranker>, notRun: readonly Candidate[]) {
  const slice = new Set(
    set.queries
      .map(query => query.id)
      .toSorted()
      .slice(0, sliceSize),
  );
  const included = (query: { readonly id: string }) => slice.has(query.id);
  const first = await firstStage(set);
  const dense = await scoreGroup(set, first, included);
  const passages = new Map(set.corpus.map(passage => [passage.id, passage.text]));
  const rows: Row[] = notRun.map(candidate => ({
    set: set.name,
    reranker: candidate.key,
    dense,
    note: `not run: ${candidate.missing ?? ''}`,
  }));

  for (const [key, reranker] of rerankers) {
    const rankings = new Map<string, readonly string[]>();
    const times: number[] = [];
    let failure: string | undefined;
    for (const query of set.queries.filter(entry => included(entry))) {
      const ids = first.get(query.id) ?? [];
      const started = performance.now();
      const ranked = await rerank(reranker, query.text, ids, { text: id => passages.get(id) ?? '', onTooLong });
      times.push(performance.now() - started);
      if (isEmbedFailure(ranked)) {
        failure = `${ranked.code}: ${ranked.message}`;
        break;
      }
      rankings.set(
        query.id,
        ranked.hits.map(hit => hit.item),
      );
      if (rankings.size % 25 === 0) progress(`  ${set.name} ${key}: ${rankings.size}/${slice.size}`);
    }
    if (failure !== undefined) {
      rows.push({ set: set.name, reranker: key, dense, note: `failed: ${failure}` });
      continue;
    }
    rows.push({
      set: set.name,
      reranker: key,
      dense,
      reranked: await scoreGroup(set, rankings, included),
      msPerQuery: { p50: percentile(times, 0.5), p95: percentile(times, 0.95) },
    });
  }
  return rows;
}

const wanted = args.rerankers?.split(',').map(key => key.trim());
const chosen = CANDIDATES.filter(candidate => wanted === undefined || wanted.includes(candidate.key));
const rerankers = new Map<string, Reranker>();
const notRun: Candidate[] = [];
for (const candidate of chosen) {
  if (candidate.missing !== undefined) {
    notRun.push(candidate);
    continue;
  }
  progress(`loading ${candidate.label}`);
  const built = await candidate.build();
  if (!('rerank' in built)) throw new Error(`${candidate.key}: ${built.message}`);
  rerankers.set(candidate.key, built);
}

const sets: RetrievalSet[] = [];
for (const name of ['scifact', 'nfcorpus', 'fiqa'] as const)
  sets.push(await loadRetrievalSet(await ensureDataset(name)));
for (const folder of args.dataset ?? []) {
  const set = await loadRetrievalSet(folder);
  if (set.queries.length === 0) progress(`${set.name}: no graded queries yet, skipped`);
  else sets.push(set);
}

const rows: Row[] = [];
for (const set of sets) {
  progress(`${set.name}: ${set.corpus.length} passages, ${Math.min(sliceSize, set.queries.length)} queries`);
  rows.push(...(await runSet(set, rerankers, notRun)));
}
for (const reranker of rerankers.values()) await reranker.dispose?.();

const points = (value: number | undefined) => (value === undefined ? '–' : (value * 100).toFixed(1));
const delta = (after: number | undefined, before: number | undefined) =>
  after === undefined || before === undefined
    ? '–'
    : `${after >= before ? '+' : ''}${((after - before) * 100).toFixed(1)}`;
const lines = [
  `Top ${DEPTH} of ollama qwen3-embedding:0.6b, ${sliceSize} test queries per set (first by id), onTooLong '${onTooLong}'.`,
  '',
  '| Set | Reranker | nDCG@10 dense | nDCG@10 reranked | Δ | MRR@10 Δ | ms/query p50 | p95 |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...rows.map(row => {
    const before = row.dense.means;
    const after = row.reranked?.means;
    return `| ${row.set} | ${row.reranker}${row.note === undefined ? '' : ` (${row.note})`} | ${points(before['ndcg@10'])} | ${points(after?.['ndcg@10'])} | ${delta(after?.['ndcg@10'], before['ndcg@10'])} | ${delta(after?.['mrr@10'], before['mrr@10'])} | ${row.msPerQuery?.p50.toFixed(0) ?? '–'} | ${row.msPerQuery?.p95.toFixed(0) ?? '–'} |`;
  }),
];
process.stdout.write(`${lines.join('\n')}\n`);

// The plan's bar for the local default: +5 nDCG@10 points over dense on at least 2 of 3 BEIR sets.
const local = rows.filter(row => row.reranker === 'bge-m3' && row.reranked !== undefined);
const wins = local.filter(row => (row.reranked?.means['ndcg@10'] ?? 0) - (row.dense.means['ndcg@10'] ?? 0) >= 0.05);
if (local.length > 0) {
  process.stdout.write(
    `\nbge-m3 target (+5 nDCG@10 on 2 of 3 sets): ${wins.length} of ${local.length} ${wins.length >= 2 ? 'met' : 'NOT met'}\n`,
  );
}

const out = path.join(ROOT, 'eval-results', `rerank-${new Date().toISOString().replaceAll(':', '-')}.json`);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ depth: DEPTH, sliceSize, onTooLong, rows }, undefined, 2));
progress(`results: ${out}`);
