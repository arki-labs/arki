// `truncate` and `quantize` against Transformers.js, and a binary first pass next to a float scan.
// Run: `bun run bench bench/quantize.bench.ts` (explore) or with `--profile publish --write-readme`.
//
// Inputs are 1 000 fixed pseudo-random unit vectors of 1 024 dims (Qwen3-Embedding-0.6B's size).
// Only throughput is measured here; the retrieval quality of binary + rescore needs real
// embeddings and lands with slice 6's SciFact fixtures.

import { quantize_embeddings, Tensor } from '@huggingface/transformers';

import type { EmbeddingModel } from '@arki/embeddings';
import { compare, defineSuite, scenario } from '@arki/bench';
import { calibrateInt8, hamming, isEmbedFailure, l2Normalize, quantize, truncate } from '@arki/embeddings';

const DIMENSIONS = 1024;
const SHORT = 256;
const COUNT = 1000;

/** Park–Miller LCG: the same vectors on every run and runtime. */
function vectors(count: number, seed: number): Float32Array[] {
  let state = seed;
  const next = () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647 - 0.5;
  };
  return Array.from({ length: count }, () => l2Normalize(Float32Array.from({ length: DIMENSIONS }, next)));
}

const CORPUS = vectors(COUNT, 42);
const FLAT = new Float32Array(COUNT * DIMENSIONS);
for (const [index, vector] of CORPUS.entries()) FLAT.set(vector, index * DIMENSIONS);

/** Only what `truncate` reads: the sizes and whether vectors are unit length. */
const qwen: EmbeddingModel = {
  provider: 'ollama',
  id: 'qwen3-embedding:0.6b',
  assurance: 'operator-pinned',
  local: true,
  dimensions: DIMENSIONS,
  matryoshka: [1024, 768, 512, 256],
  maxInputTokens: 32_768,
  maxBatch: 64,
  maxBatchTokens: 65_536,
  normalized: true,
  instruction: { version: 1 },
  inputs: ['text'],
  quantizations: [],
  embedTexts: () => Promise.reject(new Error('not used by this bench')),
};

/** Bytes → one comparable string: FNV-1a over every byte, in order. */
function fingerprintBytes(chunks: readonly Iterable<number>[]): string {
  let hash = 2_166_136_261;
  let length = 0;
  for (const chunk of chunks) {
    for (const element of chunk) {
      hash = Math.imul(hash ^ (element & 0xFF), 16_777_619) >>> 0;
      length++;
    }
  }
  return `${length}:${hash.toString(16)}`;
}

/** The truncation computed in float64 by neither library: each vector's first 256 values over their norm. */
const REFERENCE = CORPUS.map(vector => {
  const prefix = Float64Array.from(vector.subarray(0, SHORT));
  const length = Math.sqrt(prefix.reduce((sum, value) => sum + value * value, 0));
  return prefix.map(value => value / length);
});
const TOLERANCE = 1e-6;

/**
 * Float32 rows round in different orders (the two libraries differ by ~1.5e-8), so the contract is
 * a tolerance against the float64 reference, not equal bits.
 */
function withinReference(chunks: readonly ArrayLike<number>[]): string {
  let worst = chunks.length === REFERENCE.length ? 0 : Number.POSITIVE_INFINITY;
  for (const [row, chunk] of chunks.entries()) {
    const reference = REFERENCE[row];
    if (reference === undefined || chunk.length !== SHORT) return 'wrong shape';
    for (let index = 0; index < SHORT; index++)
      worst = Math.max(worst, Math.abs((chunk[index] ?? 0) - (reference[index] ?? 0)));
  }
  return worst <= TOLERANCE ? `within ${TOLERANCE}` : `off by ${worst}`;
}

function arkiBinary(corpus: readonly Float32Array[]): Uint8Array[] {
  return corpus.map(vector => {
    const bits = quantize(vector, 'binary');
    if (isEmbedFailure(bits)) throw new Error(bits.message);
    return bits;
  });
}

function transformersBinary(flat: Float32Array): Uint8Array[] {
  const packed = quantize_embeddings(new Tensor('float32', flat, [COUNT, DIMENSIONS]), 'ubinary');
  const data = packed.data;
  if (!(data instanceof Uint8Array)) throw new Error('ubinary did not answer bytes');
  const width = DIMENSIONS / 8;
  return Array.from({ length: COUNT }, (_, index) => data.subarray(index * width, (index + 1) * width));
}

function arkiTruncate(corpus: readonly Float32Array[]): Float32Array[] {
  return corpus.map(vector => {
    const short = truncate(vector, SHORT, qwen);
    if (isEmbedFailure(short)) throw new Error(short.message);
    return short;
  });
}

function transformersTruncate(flat: Float32Array): Float32Array[] {
  const short = new Tensor('float32', flat, [COUNT, DIMENSIONS]).slice(null, [0, SHORT]).normalize(2, -1);
  const data = short.data;
  if (!(data instanceof Float32Array)) throw new Error('normalize did not answer float32');
  return Array.from({ length: COUNT }, (_, index) => data.subarray(index * SHORT, (index + 1) * SHORT));
}

const BINARY_EXPECTED = fingerprintBytes(arkiBinary(CORPUS));

// ---- First pass: 10 000 stored vectors, one query, top 10.
const STORED = vectors(10_000, 7);
const STORED_BITS = arkiBinary(STORED);
const [QUERY = new Float32Array(DIMENSIONS)] = vectors(1, 99);
const QUERY_BITS = arkiBinary([QUERY])[0] ?? new Uint8Array(DIMENSIONS / 8);
const CALIBRATION = calibrateInt8(CORPUS);

/** The `k` smallest scores' indexes; a sort is fine at 10 000. */
function topK(scores: Float64Array, k: number): number[] {
  return [...scores.keys()].toSorted((a, b) => (scores[a] ?? 0) - (scores[b] ?? 0)).slice(0, k);
}

export default defineSuite({
  id: '@arki/embeddings/quantize',
  intro:
    'Throughput of the vector helpers on 1 000 fixed pseudo-random unit vectors of 1 024 dims. Each compare table ranks only rows whose output matched the contract.',
  notes: [
    'Both binary rows pack one bit per dimension, set above 0, most significant bit first: the outputs are byte-identical, which also checks the documented bit order.',
    'Transformers.js works on one `[1000, 1024]` tensor; `@arki/embeddings` works per vector, as `createEmbedder` does.',
    'Quality (recall@10 of binary first pass + float rescore against float search) is pending: it needs real embeddings and arrives with the SciFact fixtures of slice 6.',
  ],
  groups: [
    compare<Float32Array>({
      id: 'binary-1000',
      title: 'Binary packing, 1 000 × 1 024 dims',
      contract: { id: 'embeddings-quantize-binary/v1', description: 'packed bits, MSB first, byte-identical' },
      inputs: [FLAT],
      expected: () => BINARY_EXPECTED,
      baseline: 'arki',
      mode: 'sync',
      cases: c => ({
        arki: c({
          label: "@arki/embeddings quantize(v, 'binary')",
          package: '@arki/embeddings',
          run: () => arkiBinary(CORPUS),
          normalize: fingerprintBytes,
        }),
        transformers: c({
          label: "Transformers.js quantize_embeddings(t, 'ubinary')",
          package: '@huggingface/transformers',
          run: flat => transformersBinary(flat),
          normalize: fingerprintBytes,
        }),
      }),
    }),
    compare<Float32Array>({
      id: 'truncate-1000',
      title: 'Matryoshka 1 024 → 256 with re-normalisation, 1 000 vectors',
      contract: {
        id: 'embeddings-truncate-256/v1',
        description: 'the first 256 values over their norm, within 1e-6 of a float64 reference',
      },
      inputs: [FLAT],
      expected: () => `within ${TOLERANCE}`,
      baseline: 'arki',
      mode: 'sync',
      cases: c => ({
        arki: c({
          label: '@arki/embeddings truncate(v, 256, model)',
          package: '@arki/embeddings',
          run: () => arkiTruncate(CORPUS),
          normalize: withinReference,
        }),
        transformers: c({
          label: 'Transformers.js tensor.slice(null, [0, 256]).normalize(2, -1)',
          package: '@huggingface/transformers',
          run: flat => transformersTruncate(flat),
          normalize: withinReference,
        }),
      }),
    }),
    scenario({
      id: 'int8-1000',
      title: 'Int8 with a shared calibration, 1 000 × 1 024 dims',
      note: 'Transformers.js has no int8 quantizer to compare with.',
      mode: 'sync',
      cases: {
        arki: {
          label: "@arki/embeddings quantize(v, 'int8', calibration)",
          run: () => CORPUS.map(vector => quantize(vector, 'int8', CALIBRATION)),
        },
      },
    }),
    scenario({
      id: 'first-pass-10k',
      title: 'Top 10 of 10 000 stored vectors for one query',
      note: 'Different work (1 024 bits vs 1 024 floats per vector), so no ratio. Both rows include the same top-10 sort.',
      mode: 'sync',
      cases: {
        hamming: {
          label: 'hamming over packed bits',
          run: () =>
            topK(
              Float64Array.from(STORED_BITS, bits => hamming(bits, QUERY_BITS)),
              10,
            ),
        },
        float: {
          label: 'dot product over float32',
          run: () =>
            topK(
              Float64Array.from(STORED, vector => {
                let dot = 0;
                for (let index = 0; index < DIMENSIONS; index++) dot += (vector[index] ?? 0) * (QUERY[index] ?? 0);
                return -dot;
              }),
              10,
            ),
        },
      },
    }),
  ],
});
