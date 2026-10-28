// How long after an abort everything is quiet again: no request open, no promise pending.
// Run: `bun run bench bench/cancellation.bench.ts` (explore). The inference row loads EmbeddingGemma
// q8 from TRANSFORMERS_CACHE_DIR (or the OS temp dir), downloading about 316 MB the first time.

import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { defineSuite, metric } from '@arki/bench';
import { Cancelled, createEmbedder, embedMany, embedStream, isEmbedFailure, withResilience } from '@arki/embeddings';
import { createOllamaModel } from '@arki/embeddings/ollama';
import { createTransformersModel } from '@arki/embeddings/transformers';
import { invariant } from '@arki/failure';

const TRIALS = 30;
const DIMENSIONS = 4;

const CACHE = process.env['TRANSFORMERS_CACHE_DIR'] ?? path.join(tmpdir(), 'arki-embeddings-models');

/** The part of an Ollama `/api/embed` body the stub reads. */
const embedRequestSchema = z.object({ input: z.union([z.string(), z.array(z.string())]) });

/** Requests the stub is still answering: quiet means zero. */
let open = 0;

/** An Ollama-shaped server that answers after `delayMs`, or rejects at once when the request is aborted. */
function stubFetch(delayMs: number, status = 200) {
  return (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/api/tags')) {
      return Promise.resolve(Response.json({ models: [{ name: 'tiny:latest', digest: 'abc' }] }));
    }
    open++;
    return new Promise((resolve, reject) => {
      const done = (): void => {
        open--;
        init?.signal?.removeEventListener('abort', abort);
      };
      const timer = setTimeout(() => {
        done();
        const input =
          typeof init?.body === 'string' ? embedRequestSchema.parse(JSON.parse(init.body)).input : undefined;
        const count = Array.isArray(input) ? input.length : 1;
        const embeddings = Array.from({ length: count }, () => [0.5, 0.5, 0.5, 0.5]);
        const headers = status === 429 ? { 'retry-after': '1' } : undefined;
        resolve(Response.json({ embeddings }, { status, ...(headers ? { headers } : {}) }));
      }, delayMs);
      const abort = (): void => {
        clearTimeout(timer);
        done();
        reject(new DOMException('aborted', 'AbortError'));
      };
      init?.signal?.addEventListener('abort', abort, { once: true });
    });
  };
}

function embedderOver(fetch: ReturnType<typeof stubFetch>, maxBatch?: number) {
  const model = createOllamaModel({ id: 'tiny', dimensions: DIMENSIONS, fetch });
  if (isEmbedFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(maxBatch === undefined ? model : { ...model, maxBatch });
  if (isEmbedFailure(embedder)) throw new Error(embedder.message);
  return embedder;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const docs = (count: number) => Array.from({ length: count }, (_, index) => `doc ${index}`);

/** Waits until no stub request is open; the time it took is part of the measurement. */
async function quiet(): Promise<void> {
  while (open > 0) await sleep(0);
}

/** 95th percentile of `TRIALS` runs of `trial`, each returning ms from abort to quiet. */
async function p95(trial: () => Promise<number>): Promise<number> {
  const times: number[] = [];
  for (let index = 0; index < TRIALS; index++) times.push(await trial());
  times.sort((a, b) => a - b);
  return times[Math.ceil(TRIALS * 0.95) - 1] ?? Number.NaN;
}

/** Abort while most items still wait in the stream's queue behind one slow request. */
async function duringQueue(): Promise<number> {
  const reader = embedStream(embedderOver(stubFetch(20), 4), docs(400), {
    text: doc => doc,
    concurrency: 1,
  }).getReader();
  await reader.read();
  const started = performance.now();
  await reader.cancel();
  await quiet();
  return performance.now() - started;
}

/** Abort while `withResilience` waits out a 1 s `retry-after`. */
async function duringRetry(): Promise<number> {
  const embedder = withResilience(embedderOver(stubFetch(1, 429)));
  const controller = new AbortController();
  const result = embedMany(embedder, ['a'], { signal: controller.signal });
  await sleep(20);
  const started = performance.now();
  controller.abort();
  const outcome = await result;
  await quiet();
  const elapsed = performance.now() - started;
  invariant(Cancelled.is(outcome), 'Aborted embedding work must report its cancellation.');
  return elapsed;
}

/** Abort while one request is on the wire. */
async function duringFetch(): Promise<number> {
  const controller = new AbortController();
  const result = embedMany(embedderOver(stubFetch(1000)), docs(8), { signal: controller.signal });
  await sleep(5);
  const started = performance.now();
  controller.abort();
  const outcome = await result;
  await quiet();
  const elapsed = performance.now() - started;
  invariant(Cancelled.is(outcome), 'Aborted embedding work must report its cancellation.');
  return elapsed;
}

/** Abort while the reader is busy in its own sink, with requests in flight behind it. */
async function duringSink(): Promise<number> {
  const reader = embedStream(embedderOver(stubFetch(5), 4), docs(400), {
    text: doc => doc,
    concurrency: 2,
  }).getReader();
  await reader.read();
  await sleep(10);
  const started = performance.now();
  await reader.cancel();
  await quiet();
  return performance.now() - started;
}

async function loadGemma() {
  const model = await createTransformersModel({ cacheDir: CACHE });
  if (isEmbedFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(model);
  if (isEmbedFailure(embedder)) throw new Error(embedder.message);
  return embedder;
}
const gemmaEmbedder = await loadGemma();

/** Abort just after an in-process batch of 32 started: inference cannot stop, so this is its remaining time. */
async function duringInference(): Promise<number> {
  const controller = new AbortController();
  // Inference holds the thread once it runs, so a timer would fire only after it: abort right away instead.
  const result = embedMany(gemmaEmbedder, docs(32), { signal: controller.signal });
  const started = performance.now();
  controller.abort();
  const outcome = await result;
  const elapsed = performance.now() - started;
  invariant(Cancelled.is(outcome), 'Aborted embedding work must report its cancellation.');
  return elapsed;
}

const stage = (id: string, title: string, collect: () => Promise<number>) =>
  metric({
    id,
    title,
    unit: 'ms',
    deterministic: false,
    baseline: 'arki',
    cases: {
      arki: { label: `@arki/embeddings, p95 of ${TRIALS}`, package: '@arki/embeddings', collect: () => p95(collect) },
    },
  });

export default defineSuite({
  id: '@arki/embeddings/cancellation',
  intro:
    'Time from an abort (or a stream cancel) until nothing is pending: every request closed and the call settled. Each sample is the p95 of 30 aborts. Stub servers answer over an in-process `fetch`, so no network time is measured.',
  notes: [
    'Inference cannot be interrupted once ONNX Runtime runs a batch; that row is the time left in a batch of 32, and the call then answers `Cancelled`.',
  ],
  groups: [
    stage('abort-queue', 'Cancel with items queued behind a 20 ms request (ms)', duringQueue),
    stage('abort-retry', 'Abort during a 1 s retry-after wait (ms)', duringRetry),
    stage('abort-fetch', 'Abort with a request on the wire (ms)', duringFetch),
    stage('abort-inference', 'Abort during in-process inference, EmbeddingGemma q8, 32 texts (ms)', duringInference),
    stage('abort-sink', 'Cancel while the reader is in its sink (ms)', duringSink),
  ],
});
