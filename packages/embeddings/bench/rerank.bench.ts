// In-process reranking: @arki/embeddings `rerank()` over createTransformersReranker against raw
// Transformers.js on the same pinned bge-reranker-v2-m3 q8 weights, 50 documents per query.
// Run: `bun run bench bench/rerank.bench.ts` (explore). Downloads the weights (570 MB) into
// TRANSFORMERS_CACHE_DIR, or into the OS temp dir when it is unset. Quality per reranker is
// `bench/quality/rerank.eval.ts`; this suite is only the time a call takes.

import { tmpdir } from 'node:os';
import path from 'node:path';
import { AutoModelForSequenceClassification, AutoTokenizer } from '@huggingface/transformers';
import { z } from 'zod';

import { compare, defineSuite } from '@arki/bench';
import { isEmbedFailure } from '@arki/embeddings';
import { rerank } from '@arki/embeddings/rerank';
import { createTransformersReranker } from '@arki/embeddings/transformers';

const MODEL = 'onnx-community/bge-reranker-v2-m3-ONNX';
/** The same commit `createTransformersReranker` pins by default. */
const REVISION = '6f5ff65298512715a1e669753bc754d2bc8f367b';
const CACHE = process.env['TRANSFORMERS_CACHE_DIR'] ?? path.join(tmpdir(), 'arki-embeddings-models');

const arki = await createTransformersReranker({ cacheDir: CACHE });
if (isEmbedFailure(arki)) throw new Error(arki.message);
const rawTokenizer = await AutoTokenizer.from_pretrained(MODEL, { revision: REVISION, cache_dir: CACHE });
const rawModel = await AutoModelForSequenceClassification.from_pretrained(MODEL, {
  revision: REVISION,
  cache_dir: CACHE,
  dtype: 'q8',
});
const logitsSchema = z.object({ logits: z.object({ data: z.instanceof(Float32Array) }) });

type Query = { readonly query: string; readonly documents: readonly string[] };

/** 50 passages of about 40 words, one of them the answer and many near it, the same every run. */
function query(set: number): Query {
  const topics = [
    'the VAT rate in Germany',
    'income tax in Romania',
    'VAT refunds for tourists',
    'Romanian train timetables',
    'bread recipes',
  ];
  const documents = Array.from(
    { length: 50 },
    (_, index) =>
      `Passage ${set}-${index} is about ${topics[index % topics.length] ?? ''}. ` +
      'It explains how the subject works in daily life, what people usually get wrong about it, and where to read more. '.repeat(
        2,
      ),
  );
  documents[(set * 17) % 50] =
    'The standard VAT rate in Romania is 21 percent since August 2025, with reduced rates of 11 percent.';
  return { query: 'What is the VAT rate in Romania?', documents };
}

/**
 * Each document's score rounded to 1e-3, in document order: the two rows must agree on every one.
 * Order is not compared: two documents a hair apart swap with batch padding, and either order is right.
 */
const rounded = (ranked: readonly { readonly index: number; readonly score: number }[]) =>
  ranked
    .toSorted((left, right) => left.index - right.index)
    .map(hit => `${hit.index}:${hit.score.toFixed(3)}`)
    .join(',');

export default defineSuite({
  id: '@arki/embeddings/rerank',
  intro:
    'Reranking 50 passages for one query in process, bge-reranker-v2-m3 `q8` on the CPU. Both rows load the same pinned commit and must give every passage the same score to 1e-3.',
  notes: [
    'Both rows run the 50 pairs as batches of 16 (`maxDocuments`). With `q8` weights the activations are quantized per batch, so a pair scores up to 0.002 apart in a batch of 50 and in a batch of 16 (fp16: 3e-6); the same batches are the only fair contract.',
    '`rerank()` also counts each pair with the tokenizer before the call, to refuse a pair over the limit instead of cutting it.',
    'Quality is not measured here: `bench/quality/rerank.eval.ts` measures nDCG@10 uplift per reranker on BEIR slices.',
  ],
  groups: [
    compare({
      id: 'warm-50',
      title: 'Warm, 50 passages per query',
      contract: {
        id: 'rerank-warm-50/v1',
        description: 'bge-reranker-v2-m3 q8 sigmoid score of every document, equal to 1e-3',
      },
      inputs: [query(0), query(1), query(2)],
      baseline: 'arki',
      mode: 'async',
      cases: c => ({
        arki: c({
          label: '@arki/embeddings rerank() (./transformers)',
          package: '@arki/embeddings',
          run: async ({ query: text, documents }) => {
            const ranked = await rerank(arki, text, documents, { text: document => document });
            if (isEmbedFailure(ranked)) throw new Error(ranked.message);
            return ranked.hits;
          },
          normalize: rounded,
        }),
        raw: c({
          label: 'raw Transformers.js sequence-classification calls, 16 pairs each',
          package: '@huggingface/transformers',
          run: async ({ query: text, documents }) => {
            const scores: { index: number; score: number }[] = [];
            for (let start = 0; start < documents.length; start += 16) {
              const batch = documents.slice(start, start + 16);
              const encoding = rawTokenizer(
                batch.map(() => text),
                { text_pair: batch, padding: true, truncation: true },
              );
              const { data } = logitsSchema.parse(await rawModel(encoding)).logits;
              for (const [offset, logit] of data.entries()) {
                scores.push({ index: start + offset, score: 1 / (1 + Math.exp(-logit)) });
              }
            }
            return scores.toSorted((left, right) => right.score - left.score || left.index - right.index);
          },
          normalize: rounded,
        }),
      }),
    }),
  ],
});
