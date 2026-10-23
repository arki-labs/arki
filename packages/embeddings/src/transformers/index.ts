/**
 * `@arki/embeddings/transformers`: a model run in process by Transformers.js (ONNX Runtime), no
 * server. Default: EmbeddingGemma 300M, `q8`, pinned to one Hugging Face commit. Needs the optional
 * peer `@huggingface/transformers`; runs on Node, Bun and in the browser (WebGPU or WASM), not Hermes.
 */
import type * as Transformers from '@huggingface/transformers';
import type { DataType, DeviceType, ProgressCallback } from '@huggingface/transformers';
import { z } from 'zod';

import { invariant, isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { EmbeddingModel, Instruction, NativeRequest } from '../types.js';
import { Cancelled, InvalidOutput, ModelUnavailable } from '../failures.js';
import { EMBEDDINGGEMMA_2_INSTRUCTION, EMBEDDINGGEMMA_INSTRUCTION, NO_INSTRUCTION } from '../instructions.js';
import { l2Normalize } from '../vector.js';

export type TransformersModelOptions = {
  /** Hugging Face model id. Default `'onnx-community/embeddinggemma-300m-ONNX'`. */
  readonly id?: string;
  /**
   * Commit, branch or tag. Default: the pinned commit for an id listed below, `'main'` for any other id.
   * A 40-hex commit makes the model `immutable`; anything else is `mutable`.
   */
  readonly revision?: string;
  /** ONNX weights to load. Default `'q8'`. EmbeddingGemma does not support `fp16`. */
  readonly dtype?: DataType;
  /** `'cpu'` (Node, Bun), `'webgpu'` or `'wasm'` (browser). Default: Transformers.js picks. */
  readonly device?: DeviceType;
  /** Where downloaded weights are kept. Default: Transformers.js' own cache. */
  readonly cacheDir?: string;
  /** Download and load progress, straight from Transformers.js. */
  readonly onProgress?: ProgressCallback;
  /** Overrides the prefixes; required to get them for an id other than EmbeddingGemma. */
  readonly instruction?: Instruction;
};

const EMBEDDINGGEMMA_ID = 'onnx-community/embeddinggemma-300m-ONNX';
const COMMIT = /^[0-9a-f]{40}$/;
/** What a tokenizer with no stated limit gets. */
const DEFAULT_MAX_INPUT_TOKENS = 512;
const MAX_BATCH = 32;
const PROBE = 'probe';

/**
 * Facts the observed output does not tell: the pinned commit (`sha` of `huggingface.co/api/models/<id>`,
 * read on 2026-10-21), limits, Matryoshka sizes and prefixes.
 */
const TRANSFORMERS_FACTS: Readonly<
  Record<
    string,
    Pick<EmbeddingModel, 'dimensions' | 'matryoshka' | 'maxInputTokens' | 'instruction'> & { readonly revision: string }
  >
> = {
  [EMBEDDINGGEMMA_ID]: {
    revision: '5090578d9565bb06545b4552f76e6bc2c93e4a66',
    dimensions: 768,
    matryoshka: [768, 512, 256, 128],
    maxInputTokens: 2048,
    instruction: EMBEDDINGGEMMA_INSTRUCTION,
  },
  // Apache-2.0. Transformers.js loads its vision and audio encoders too (about 850 MB in q8).
  'onnx-community/embeddinggemma-2-ONNX': {
    revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0',
    dimensions: 768,
    matryoshka: [768, 512, 256, 128],
    maxInputTokens: 8192,
    instruction: EMBEDDINGGEMMA_2_INSTRUCTION,
  },
};

const size = z.number().int().positive();
/** A pooled `[batch, dims]` output (`sentence_embedding`), as sentence-transformers exports write it. */
const pooledSchema = z.object({ dims: z.tuple([size, size]), data: z.instanceof(Float32Array) });
/** A token-level `[batch, tokens, dims]` output, mean-pooled here. */
const hiddenSchema = z.object({ dims: z.tuple([size, size, size]), data: z.instanceof(Float32Array) });
const outputSchema = z.union([
  z.object({ sentence_embedding: pooledSchema }),
  z.object({ last_hidden_state: hiddenSchema }),
]);
/** The tokenizer's padding mask, `[batch, tokens]` of 0 and 1. */
const encodingSchema = z.object({
  attention_mask: z.object({ dims: z.tuple([size, size]), data: z.instanceof(BigInt64Array) }),
});
const maxLengthSchema = z.number().int().positive().max(1_000_000);

type Rows = { readonly vectors: Float32Array[]; readonly tokens: number };

/** One loaded tokenizer and session, shared by every record created with the same key. */
type Loaded = {
  readonly dimensions: number;
  readonly maxInputTokens: number;
  readonly loadMs: number;
  readonly countTokens: (text: string) => number;
  readonly run: (texts: readonly string[]) => Promise<Rows | ReturnType<typeof InvalidOutput>>;
  readonly dispose: () => Promise<unknown>;
};
type LoadFailure = ReturnType<typeof ModelUnavailable> | ReturnType<typeof InvalidOutput>;
type Shared = { readonly load: Promise<Loaded | LoadFailure>; refs: number; loadReported: boolean };

/** Loads in flight or done, by id, revision, dtype, device and cache dir: concurrent creates share one. */
const loads = new Map<string, Shared>();

/** Mean of the unmasked token vectors of each row, L2-normalised. */
function meanPool(hidden: z.output<typeof hiddenSchema>, mask: BigInt64Array): Float32Array[] {
  const [batch, tokens, dims] = hidden.dims;
  return Array.from({ length: batch }, (_, row) => {
    const sum = new Float32Array(dims);
    let counted = 0;
    for (let token = 0; token < tokens; token++) {
      if (mask[row * tokens + token] === 0n) continue;
      counted++;
      const base = (row * tokens + token) * dims;
      for (let dim = 0; dim < dims; dim++) sum[dim] = (sum[dim] ?? 0) + (hidden.data[base + dim] ?? 0);
    }
    for (let dim = 0; dim < dims; dim++) sum[dim] = (sum[dim] ?? 0) / Math.max(counted, 1);
    return l2Normalize(sum);
  });
}

async function load(
  id: string,
  revision: string,
  options: TransformersModelOptions,
  maxInputTokens: number | undefined,
): Promise<Loaded | LoadFailure> {
  const log = getLogger('arki:embeddings');
  let transformers: typeof Transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch {
    return ModelUnavailable({ model: id, reason: 'peer-missing' });
  }
  const started = performance.now();
  log.debug('transformers loading {model}@{revision}', { model: id, revision });
  const shared = {
    revision,
    ...(options.cacheDir === undefined ? {} : { cache_dir: options.cacheDir }),
    ...(options.onProgress === undefined ? {} : { progress_callback: options.onProgress }),
  };
  let tokenizer: Awaited<ReturnType<typeof transformers.AutoTokenizer.from_pretrained>>;
  let model: Awaited<ReturnType<typeof transformers.AutoModel.from_pretrained>>;
  try {
    tokenizer = await transformers.AutoTokenizer.from_pretrained(id, shared);
    model = await transformers.AutoModel.from_pretrained(id, {
      ...shared,
      dtype: options.dtype ?? 'q8',
      ...(options.device === undefined ? {} : { device: options.device }),
    });
  } catch (error) {
    log.debug('transformers could not load {model}: {error}', {
      model: id,
      error: error instanceof Error ? error.message : String(error),
    });
    const missing = error instanceof transformers.ModelFileNotFoundError;
    return ModelUnavailable({ model: id, reason: missing ? 'unknown-model' : 'unreachable' });
  }
  const stated = maxLengthSchema.safeParse(tokenizer.model_max_length);
  const limit = maxInputTokens ?? (stated.success ? stated.data : DEFAULT_MAX_INPUT_TOKENS);

  const run = async (texts: readonly string[]): Promise<Rows | ReturnType<typeof InvalidOutput>> => {
    try {
      // Over-long inputs were refused before this call unless the caller asked to truncate.
      const encoding = tokenizer([...texts], { padding: true, truncation: true, max_length: limit });
      const output: unknown = await model(encoding);
      const parsed = outputSchema.safeParse(output);
      const mask = encodingSchema.safeParse(encoding);
      if (!parsed.success || !mask.success) {
        return InvalidOutput({ reason: 'transformers.js answered without sentence_embedding or last_hidden_state' });
      }
      const tokens = mask.data.attention_mask.data.reduce((total, value) => total + value, 0n);
      if ('sentence_embedding' in parsed.data) {
        const { dims, data } = parsed.data.sentence_embedding;
        const vectors = Array.from({ length: dims[0] }, (_, row) =>
          l2Normalize(data.slice(row * dims[1], (row + 1) * dims[1])),
        );
        return { vectors, tokens: Number(tokens) };
      }
      return {
        vectors: meanPool(parsed.data.last_hidden_state, mask.data.attention_mask.data),
        tokens: Number(tokens),
      };
    } catch (error) {
      return InvalidOutput({ reason: `transformers.js failed: ${error instanceof Error ? error.message : 'unknown'}` });
    }
  };

  // Observed dims: the size is whatever the loaded weights answer, not what a table says.
  const probe = await run([PROBE]);
  if (isFailure(probe)) {
    await model.dispose();
    return probe;
  }
  const loadMs = performance.now() - started;
  const dimensions = probe.vectors[0]?.length ?? 0;
  log.debug('transformers loaded {model} in {loadMs} ms, {dimensions} dims', { model: id, loadMs, dimensions });
  return {
    dimensions,
    maxInputTokens: limit,
    loadMs,
    countTokens: text => tokenizer.encode(text).length,
    run,
    dispose: () => model.dispose(),
  };
}

/**
 * Loads a model in process and embeds one probe text, so `dimensions` is what the weights produce.
 * Concurrent calls with the same id, revision, dtype, device and cache dir share one load; the
 * session is freed when every record from it has called `dispose()`. `countTokens` is exact (the
 * loaded tokenizer). The first load downloads the weights (about 316 MB for EmbeddingGemma `q8`).
 *
 * @example
 * const model = await createTransformersModel({ cacheDir: '.cache/models' });
 * if (isEmbedFailure(model)) return model; // ModelUnavailable: peer-missing, unknown-model or unreachable
 * const embedder = createEmbedder(model);
 * @fix `peer-missing`: `bun add @huggingface/transformers`. `unreachable`: check the network or `cacheDir`.
 */
export async function createTransformersModel(options: TransformersModelOptions = {}) {
  const id = options.id ?? EMBEDDINGGEMMA_ID;
  const facts = TRANSFORMERS_FACTS[id];
  const revision = options.revision ?? facts?.revision ?? 'main';
  const key = JSON.stringify([id, revision, options.dtype ?? 'q8', options.device ?? '', options.cacheDir ?? '']);

  let shared = loads.get(key);
  if (shared === undefined) {
    const created: Shared = { load: load(id, revision, options, facts?.maxInputTokens), refs: 0, loadReported: false };
    loads.set(key, created);
    shared = created;
  }
  shared.refs++;
  const owner = shared;
  const loaded = await owner.load;
  if (isFailure(loaded)) {
    // A failed load is forgotten, so the next create tries again.
    if (loads.get(key) === owner) loads.delete(key);
    return loaded;
  }

  let disposed = false;
  const dimensions = loaded.dimensions;
  const embedTexts = async ({ texts, dimensions: requested, signal }: NativeRequest) => {
    invariant(!disposed, `transformers model ${id} was used after dispose()`);
    if (signal?.aborted) return Cancelled();
    const rows = await loaded.run(texts);
    // Inference cannot be interrupted; a call aborted meanwhile is still cancelled.
    if (signal?.aborted) return Cancelled();
    if (isFailure(rows)) return rows;
    const vectors =
      requested === undefined ? rows.vectors : rows.vectors.map(row => l2Normalize(row.slice(0, requested)));
    // One load is reported once, by whichever record over it embeds first.
    const loadMs = owner.loadReported ? undefined : loaded.loadMs;
    owner.loadReported = true;
    return {
      vectors,
      tokens: { basis: 'counted' as const, count: rows.tokens },
      ...(loadMs === undefined ? {} : { loadMs }),
    };
  };

  const model: EmbeddingModel = {
    provider: 'transformers',
    id,
    revision,
    assurance: COMMIT.test(revision) ? 'immutable' : 'mutable',
    local: true,
    dimensions,
    // Matryoshka sizes hold only for the weights the table describes.
    matryoshka: facts?.dimensions === dimensions ? facts.matryoshka : [],
    maxInputTokens: loaded.maxInputTokens,
    maxBatch: MAX_BATCH,
    maxBatchTokens: MAX_BATCH * loaded.maxInputTokens,
    normalized: true,
    instruction: options.instruction ?? facts?.instruction ?? NO_INSTRUCTION,
    inputs: ['text'],
    quantizations: [],
    countTokens: loaded.countTokens,
    embedTexts,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      owner.refs--;
      if (owner.refs > 0) return;
      if (loads.get(key) === owner) loads.delete(key);
      await loaded.dispose();
    },
  };
  return model;
}

export { createTransformersReranker } from './rerank.js';
export type { TransformersRerankerOptions } from './rerank.js';
