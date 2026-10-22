// Retrieval quality per model: nDCG@10, recall@10/50 and MRR@10 on SciFact and NFCorpus (BEIR),
// on any folder in the BEIR shape passed with `--dataset` (fleet/embeddings-eval/ro-retrieval-v1),
// and Spearman's rho on RO-STS. BM25 is the floor. Gate D1 runs when a set has protected domains.
//
// Run from packages/embeddings: `bun run eval [--models a,b] [--dataset <dir>] [--self-check]`.
// Unlike the benches, the numbers do not move with machine load: the same weights give the same vectors.
//
// Candidates: every § 5 local default, the two trials of founder decision A1/E1, and the hosted
// defaults when their key is set. Harrier needs a TEI server, at `--harrier-url` (default below):
// `docker run -p 8091:80 ghcr.io/huggingface/text-embeddings-inference:cpu-arm64-latest --model-id microsoft/harrier-oss-v1-0.6b --max-batch-tokens 8192 --auto-truncate`

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

import type { Embedder, EmbeddingModel, EmbeddingModelRef, EmbedFailure } from '@arki/embeddings';
import {
  createEmbedder,
  embedMany,
  isEmbedFailure,
  l2Normalize,
  QWEN3_INSTRUCTION,
  resolveEmbeddingModel,
  resolveSpace,
  spaceId,
} from '@arki/embeddings';
import { createOllamaModel } from '@arki/embeddings/ollama';
import { createOpenAICompatibleModel } from '@arki/embeddings/openai-compatible';
import { createTransformersModel } from '@arki/embeddings/transformers';

import type { RetrievalSet } from './quality/beir.js';
import type { GroupScores } from './quality/retrieval.js';
import { loadRetrievalSet, loadSimilarityPairs } from './quality/beir.js';
import { ensureDataset } from './quality/datasets.js';
import { bm25, gateD1, PROTECTED_DOMAINS, scoreGroup, searchDense, spearman } from './quality/retrieval.js';

const OLLAMA = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
const MODEL_CACHE = process.env['TRANSFORMERS_CACHE_DIR'] ?? path.join(tmpdir(), 'arki-embeddings-models');
const RESULTS = path.join(import.meta.dirname, '..', '.cache', 'eval-results');
const TOP = 100;
/** The A1 default: every other candidate is gated against it. */
const BASELINE = 'qwen3-0.6b';

const { values: args } = parseArgs({
  options: {
    models: { type: 'string' },
    dataset: { type: 'string', multiple: true },
    'self-check': { type: 'boolean', default: false },
    'harrier-url': { type: 'string', default: 'http://localhost:8091/v1' },
  },
});

type Candidate = {
  readonly key: string;
  readonly label: string;
  /** An env var the candidate needs; without it the row is listed as not run, never silently dropped. */
  readonly needs?: string;
  readonly build: () => EmbeddingModel | EmbedFailure | Promise<EmbeddingModel | EmbedFailure>;
};

const hosted = (key: string, ref: EmbeddingModelRef, needs: string): Candidate => ({
  key,
  label: `${ref} (hosted)`,
  needs,
  build: () => resolveEmbeddingModel(ref, process.env),
});

const CANDIDATES: readonly Candidate[] = [
  {
    key: BASELINE,
    label: 'ollama qwen3-embedding:0.6b (local default, A1)',
    build: () => createOllamaModel({ id: 'qwen3-embedding:0.6b', baseURL: OLLAMA }),
  },
  {
    key: 'qwen3-4b',
    label: 'ollama qwen3-embedding:4b (GPU tier)',
    // Not in ./ollama's facts table yet: its card's size and Qwen3's prefixes.
    build: () =>
      createOllamaModel({
        id: 'qwen3-embedding:4b',
        baseURL: OLLAMA,
        dimensions: 2560,
        instruction: QWEN3_INSTRUCTION,
      }),
  },
  {
    key: 'harrier-0.6b',
    label: 'microsoft/harrier-oss-v1-0.6b on TEI (trial, A1)',
    build: () =>
      createOpenAICompatibleModel({
        id: 'microsoft/harrier-oss-v1-0.6b',
        baseURL: args['harrier-url'],
        dimensions: 1024,
        // The server above runs with `--max-batch-tokens 8192`: its default 32K budget runs out of memory on CPU.
        maxInputTokens: 8192,
        maxBatchTokens: 8192,
        // On CPU a batch of 32 queued for minutes and the connection dropped; 8 returns in seconds.
        maxBatch: 8,
        // Harrier's `web_search_query` prompt is Qwen3's, word for word (its config_sentence_transformers.json).
        instruction: QWEN3_INSTRUCTION,
      }),
  },
  {
    key: 'embeddinggemma',
    label: 'EmbeddingGemma 300M q8, Transformers.js (in-process default)',
    build: () => createTransformersModel({ cacheDir: MODEL_CACHE }),
  },
  {
    key: 'embeddinggemma-2',
    label: 'EmbeddingGemma 2 q8, Transformers.js (trial, E1)',
    build: () => createTransformersModel({ id: 'onnx-community/embeddinggemma-2-ONNX', cacheDir: MODEL_CACHE }),
  },
  hosted('openai-3-small', 'openai:text-embedding-3-small', 'OPENAI_API_KEY'),
  hosted('voyage-3.5', 'voyage:voyage-3.5', 'VOYAGE_API_KEY'),
  hosted('gemini-2', 'google:gemini-embedding-2', 'GOOGLE_GENERATIVE_AI_API_KEY'),
];

const progress = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** Unit-length float vectors, or a thrown error: a quantized or failed batch has no place in this eval. */
async function vectors(
  embedder: Embedder,
  texts: readonly string[],
  purpose: 'query' | 'document' | 'similarity',
  what: string,
): Promise<Float32Array[]> {
  const started = performance.now();
  const batch = await embedMany(embedder, texts, {
    purpose,
    onTooLong: 'truncate',
    concurrency: 2,
    onProgress: (done, total) => {
      if (done === total || done % 2048 < 32) progress(`  ${what}: ${done}/${total}`);
    },
  });
  if (isEmbedFailure(batch)) throw new Error(`${what}: ${batch.code} ${batch.message}`);
  progress(`  ${what}: ${texts.length} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  return batch.vectors.map(vector => {
    if (!(vector instanceof Float32Array)) throw new Error(`${what}: expected float32 vectors`);
    return l2Normalize(vector);
  });
}

type SetResult = { readonly overall: GroupScores; readonly groups: Readonly<Record<string, GroupScores>> };

/** Overall, then one group per domain and per stress slice the set tags. */
async function scoreSet(set: RetrievalSet, rankings: ReadonlyMap<string, readonly string[]>): Promise<SetResult> {
  const overall = await scoreGroup(set, rankings);
  const groups: Record<string, GroupScores> = {};
  for (const domain of new Set(set.queries.flatMap(query => (query.domain === undefined ? [] : [query.domain])))) {
    groups[`domain:${domain}`] = await scoreGroup(set, rankings, query => query.domain === domain);
  }
  for (const slice of new Set(set.queries.flatMap(query => query.slices))) {
    groups[`slice:${slice}`] = await scoreGroup(set, rankings, query => query.slices.includes(slice));
  }
  return { overall, groups };
}

async function denseResult(embedder: Embedder, set: RetrievalSet): Promise<SetResult> {
  const docs = await vectors(
    embedder,
    set.corpus.map(passage => passage.text),
    'document',
    `${set.name} corpus`,
  );
  const queries = await vectors(
    embedder,
    set.queries.map(query => query.text),
    'query',
    `${set.name} queries`,
  );
  const ranked = searchDense(
    set.corpus.map(passage => passage.id),
    docs,
    queries,
    TOP,
  );
  return scoreSet(set, new Map(set.queries.map((query, index) => [query.id, ranked[index] ?? []])));
}

async function similarityResult(embedder: Embedder, file: string): Promise<number> {
  const pairs = await loadSimilarityPairs(file);
  const a = await vectors(
    embedder,
    pairs.map(pair => pair.a),
    'similarity',
    'ro-sts a',
  );
  const b = await vectors(
    embedder,
    pairs.map(pair => pair.b),
    'similarity',
    'ro-sts b',
  );
  const cosines = a.map((left, index) => {
    const right = b[index] ?? left;
    return left.reduce((sum, value, dim) => sum + value * (right[dim] ?? 0), 0);
  });
  return spearman(
    cosines,
    pairs.map(pair => pair.score),
  );
}

/**
 * The plan's self-check: Qwen3 0.6B through the library and through a bare `/api/embed` call with
 * the card's prefix typed out here. More than 0.001 nDCG@10 apart means the wrapper changed something.
 */
const rawEmbedSchema = z.object({ embeddings: z.array(z.array(z.number())) });

async function selfCheck(
  set: RetrievalSet,
  wrapped: number,
): Promise<{ readonly raw: number; readonly pass: boolean }> {
  const raw = async (texts: readonly string[]): Promise<Float32Array[]> => {
    const out: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += 32) {
      const response = await fetch(`${OLLAMA}/api/embed`, {
        method: 'POST',
        body: JSON.stringify({ model: 'qwen3-embedding:0.6b', input: texts.slice(start, start + 32) }),
      });
      const { embeddings } = rawEmbedSchema.parse(await response.json());
      for (const row of embeddings) out.push(l2Normalize(Float32Array.from(row)));
    }
    return out;
  };
  const query = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ';
  const docs = await raw(set.corpus.map(passage => passage.text));
  const queries = await raw(set.queries.map(item => `${query}${item.text}`));
  const ranked = searchDense(
    set.corpus.map(passage => passage.id),
    docs,
    queries,
    TOP,
  );
  const scores = await scoreGroup(set, new Map(set.queries.map((item, index) => [item.id, ranked[index] ?? []])));
  const rawNdcg = scores.means['ndcg@10'] ?? 0;
  return { raw: rawNdcg, pass: Math.abs(rawNdcg - wrapped) <= 0.001 };
}

const only = args.models?.split(',');
const sets = [
  await loadRetrievalSet(await ensureDataset('scifact')),
  await loadRetrievalSet(await ensureDataset('nfcorpus')),
  ...(await Promise.all((args.dataset ?? []).map(folder => loadRetrievalSet(path.resolve(folder))))),
];
const stsFile = path.join(await ensureDataset('ro-sts'), 'test.tsv');

type Row = {
  readonly key: string;
  readonly label: string;
  readonly space?: string;
  readonly skipped?: string;
  readonly sets: Readonly<Record<string, SetResult>>;
  readonly roSts?: number;
};
const rows: Row[] = [];

const bm25Sets: Record<string, SetResult> = {};
for (const set of sets) {
  const search = bm25(set.corpus);
  bm25Sets[set.name] = await scoreSet(set, new Map(set.queries.map(query => [query.id, search(query.text, TOP)])));
}
rows.push({ key: 'bm25', label: 'BM25 (k1 1.2, b 0.75, no stemming)', sets: bm25Sets });

for (const candidate of CANDIDATES) {
  if (only !== undefined && !only.includes(candidate.key)) continue;
  if (candidate.needs !== undefined && process.env[candidate.needs] === undefined) {
    rows.push({ key: candidate.key, label: candidate.label, skipped: `${candidate.needs} not set`, sets: {} });
    continue;
  }
  progress(`${candidate.key}: ${candidate.label}`);
  const model = await candidate.build();
  if (isEmbedFailure(model)) {
    rows.push({ key: candidate.key, label: candidate.label, skipped: `${model.code}: ${model.message}`, sets: {} });
    continue;
  }
  const embedder = createEmbedder(model);
  if (isEmbedFailure(embedder)) throw new Error(`${candidate.key}: ${embedder.message}`);
  // Pins Ollama's digest before the first call, so the recorded space names the exact weights.
  const space = await resolveSpace(embedder);
  if (isEmbedFailure(space)) {
    rows.push({ key: candidate.key, label: candidate.label, skipped: `${space.code}: ${space.message}`, sets: {} });
    continue;
  }
  const results: Record<string, SetResult> = {};
  for (const set of sets) {
    if (set.queries.length === 0) continue;
    results[set.name] = await denseResult(embedder, set);
  }
  rows.push({
    key: candidate.key,
    label: candidate.label,
    space: spaceId(space),
    sets: results,
    roSts: await similarityResult(embedder, stsFile),
  });
  await model.dispose?.();
}

// ---- Report ------------------------------------------------------------------------------------

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};
const metric = (result: GroupScores | undefined, name: string): string => {
  const value = result?.means[name];
  return value === undefined ? '–' : value.toFixed(3);
};

const scored = sets.filter(set => set.queries.length > 0);
out(`| Model | ${scored.map(set => `${set.name} nDCG@10 | R@10 | R@50 | MRR@10`).join(' | ')} | RO-STS ρ |`);
out(`| --- |${' ---: |'.repeat(scored.length * 4 + 1)}`);
for (const row of rows) {
  if (row.skipped !== undefined) {
    out(`| ${row.label} | not run: ${row.skipped} |`);
    continue;
  }
  const cells = scored.flatMap(set =>
    ['ndcg@10', 'recall@10', 'recall@50', 'mrr@10'].map(name => metric(row.sets[set.name]?.overall, name)),
  );
  out(`| ${row.label} | ${cells.join(' | ')} | ${row.roSts === undefined ? '–' : row.roSts.toFixed(3)} |`);
}
for (const set of sets) {
  if (set.queries.length === 0) out(`\n${set.name}: 0 graded queries, not scored.`);
}

for (const set of scored) {
  const groups = Object.keys(rows.find(row => row.sets[set.name] !== undefined)?.sets[set.name]?.groups ?? {});
  if (groups.length === 0) continue;
  out(`\n${set.name} nDCG@10 by domain and stress slice`);
  out(`| Model | ${groups.join(' | ')} |`);
  out(`| --- |${' ---: |'.repeat(groups.length)}`);
  for (const row of rows) {
    if (row.skipped === undefined)
      out(
        `| ${row.label} | ${groups.map(group => metric(row.sets[set.name]?.groups[group], 'ndcg@10')).join(' | ')} |`,
      );
  }
}

/** Domain → nDCG@10 over every set that tags domains. */
const domainScores = (row: Row): Record<string, number> => {
  const scores: Record<string, number> = {};
  for (const result of Object.values(row.sets)) {
    for (const domain of PROTECTED_DOMAINS) {
      const value = result.groups[`domain:${domain}`]?.means['ndcg@10'];
      if (value !== undefined) scores[domain] = value;
    }
  }
  return scores;
};
const baseline = rows.find(row => row.key === BASELINE && row.skipped === undefined);
out('\nGate D1 (a swap may not drop any protected domain by more than 0.01 nDCG@10)');
for (const row of rows) {
  if (row.key === BASELINE || row.key === 'bm25' || row.skipped !== undefined) continue;
  const verdict = baseline === undefined ? undefined : gateD1(domainScores(baseline), domainScores(row));
  out(
    `- ${row.label}: ${verdict === undefined ? 'no baseline run' : verdict.pass ? 'PASS' : `BLOCKED (${verdict.reasons.join('; ')})`}`,
  );
}

let failed = false;
if (args['self-check']) {
  const scifact = sets.find(set => set.name === 'scifact');
  const wrapped = baseline?.sets['scifact']?.overall.means['ndcg@10'];
  if (scifact === undefined || wrapped === undefined) {
    out('\nSelf-check: needs the qwen3-0.6b row on scifact.');
    failed = true;
  } else {
    const check = await selfCheck(scifact, wrapped);
    out(
      `\nSelf-check (wrapper vs raw /api/embed, SciFact nDCG@10): ${wrapped.toFixed(4)} vs ${check.raw.toFixed(4)} → ${check.pass ? 'PASS' : 'FAIL'}`,
    );
    failed = !check.pass;
  }
}

await mkdir(RESULTS, { recursive: true });
const file = path.join(RESULTS, `quality-${new Date().toISOString().replaceAll(':', '-')}.json`);
await writeFile(file, `${JSON.stringify({ when: new Date().toISOString(), rows }, undefined, 2)}\n`);
progress(`results: ${file}`);
if (failed) process.exitCode = 1;
