/**
 * A reranker run in process by Transformers.js: a cross-encoder (one relevance logit per pair, e.g.
 * bge-reranker-v2-m3) or Qwen3-Reranker (a chat model asked "yes" or "no"). Needs the optional peer
 * `@huggingface/transformers`; Node, Bun and the browser, not Hermes.
 */
import type * as Transformers from '@huggingface/transformers';
import type { DataType, DeviceType, ProgressCallback } from '@huggingface/transformers';
import { z } from 'zod';

import { invariant, isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';
import type { SchemaWithJson } from '@arki/schema';
import { assert } from '@arki/schema';

import type { Reranker, RerankHit } from '../rerank/index.js';
import { Cancelled, InputTooLong, InvalidOutput, ModelUnavailable, UnsupportedInput } from '../failures.js';
import { withOptionsJson } from '../schemas.js';
import { deviceSchema, dtypeSchema, progressCallbackSchema } from './fields.js';

export type TransformersRerankerOptions = {
  /** Hugging Face model id. Default `'onnx-community/bge-reranker-v2-m3-ONNX'`. */
  readonly id?: string;
  /** Commit, branch or tag. Default: the pinned commit for an id listed below, `'main'` for any other id. */
  readonly revision?: string;
  /** ONNX weights to load. Default `'q8'` (570 MB for bge-reranker-v2-m3, 1.2 GB for Qwen3-Reranker-0.6B). */
  readonly dtype?: DataType;
  /** `'cpu'` (Node, Bun), `'webgpu'` or `'wasm'` (browser). Default: Transformers.js picks. */
  readonly device?: DeviceType;
  /** Where downloaded weights are kept. Default: Transformers.js' own cache. */
  readonly cacheDir?: string;
  readonly onProgress?: ProgressCallback;
  /**
   * Tokens one pair may take, prompt and special tokens included. Default 1024: a pair costs time
   * with the square of its length, and longer documents can be split by `rerank()`.
   */
  readonly maxInputTokens?: number;
  /** Qwen3-Reranker only: the task line. Default: its card's web-search instruction. */
  readonly instruction?: string;
};

/** `TransformersRerankerOptions`, checked by `createTransformersReranker`; a type test locks it to the type. */
// Annotated: declaration emit cannot name the peer's `ProgressCallback` inside an inferred type. The
// assignment fails to compile when zod's output does not fit `TransformersRerankerOptions`; the other direction
// (no field forgotten) is the "keep every options field" test in `schemas.test.ts`.
export const transformersRerankerOptionsSchema: SchemaWithJson<TransformersRerankerOptions, TransformersRerankerOptions> = withOptionsJson(
  z
    .object({
      id: z.string().min(1).optional(),
      revision: z.string().min(1).optional(),
      dtype: dtypeSchema.optional(),
      device: deviceSchema.optional(),
      cacheDir: z.string().min(1).optional(),
      onProgress: progressCallbackSchema.optional(),
      maxInputTokens: z.number().int().positive().optional(),
      instruction: z.string().optional(),
    })
    .readonly(),
);

type Kind = 'cross-encoder' | 'qwen3';

const BGE_ID = 'onnx-community/bge-reranker-v2-m3-ONNX';
/**
 * `sha` of `huggingface.co/api/models/<id>` (read 2026-10-23). Any other id is loaded as a
 * one-logit cross-encoder; the probe at load refuses it when it is not one.
 */
const RERANK_FACTS: Readonly<Record<string, { readonly revision: string; readonly kind: Kind }>> = {
  [BGE_ID]: { revision: '6f5ff65298512715a1e669753bc754d2bc8f367b', kind: 'cross-encoder' },
  'onnx-community/Qwen3-Reranker-0.6B-ONNX': { revision: '9995c50e2310679108a55f5ccd16ba8be9f17c20', kind: 'qwen3' },
};
const MAX_DOCUMENTS = 16;

// The format the model was trained on: the Transformers example of the original card,
// huggingface.co/Qwen/Qwen3-Reranker-0.6B (read 2026-10-23), character for character. The ONNX
// copy's card puts blank lines between the parts and drops the last newline; the original wins.
const QWEN3_DEFAULT_INSTRUCTION = 'Given a web search query, retrieve relevant passages that answer the query';
const QWEN3_PREFIX =
  '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. ' +
  'Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n';
const QWEN3_SUFFIX = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n';
const qwen3Prompt = (instruction: string, query: string, document: string) =>
  `${QWEN3_PREFIX}<Instruct>: ${instruction}\n<Query>: ${query}\n<Document>: ${document}${QWEN3_SUFFIX}`;

const size = z.number().int().positive();
/** A cross-encoder answers one logit per pair. */
const classifierSchema = z.object({
  logits: z.object({ dims: z.tuple([size, z.literal(1)]), data: z.instanceof(Float32Array) }),
});
/** A causal LM answers a logit per vocabulary entry at every position; the last one is the answer. */
const causalSchema = z.object({
  logits: z.object({ dims: z.tuple([z.literal(1), size, size]), data: z.instanceof(Float32Array) }),
});
const tokenIdSchema = z.number().int().nonnegative();

const sigmoid = (logit: number) => 1 / (1 + Math.exp(-logit));

/** Tokens of the query and of each document, counted once per call and shared by every check. */
type Counts = { readonly query: number; readonly documents: readonly number[] };

type Scorer = (
  query: string,
  documents: readonly string[],
  counts: Counts,
  truncate: boolean,
  signal?: AbortSignal,
) => Promise<
  readonly number[] | ReturnType<typeof InvalidOutput> | ReturnType<typeof InputTooLong> | ReturnType<typeof Cancelled>
>;

/**
 * Loads a reranker in process and scores one probe pair, so a model that is not the kind expected
 * fails here and not on the first query. `countTokens` is exact (the loaded tokenizer). Each call
 * loads its own session; `dispose()` frees it. Qwen3-Reranker scores one document per model run:
 * its output holds a logit per vocabulary entry (151k) at every position.
 *
 * `q8` weights quantize activations per batch, so a score moves by up to 0.002 with the other
 * documents in its batch (measured on bge-reranker-v2-m3; `fp16` holds it to 3e-6). Rankings are
 * not affected in practice; an exact repeat needs the same batches or `fp16`.
 *
 * @example
 * const reranker = await createTransformersReranker({ cacheDir: '.cache/models' });
 * if (isFailure(reranker)) return reranker; // ModelUnavailable: peer-missing, unknown-model or unreachable
 * const ranked = await rerank(reranker, 'cum se calculează TVA?', hits, { text: hit => hit.text, topK: 10 });
 * @fix `peer-missing`: `bun add @huggingface/transformers`. `unreachable`: check the network or `cacheDir`.
 */
export async function createTransformersReranker(
  options: TransformersRerankerOptions = {},
): Promise<Reranker | ReturnType<typeof ModelUnavailable> | ReturnType<typeof InvalidOutput>> {
  // Checked before the load, so a misuse never leaves an ONNX session behind. This factory's return
  // type has no `ConfigurationFailure`, and it threw on a bad `maxInputTokens` before, so it still throws.
  assert(options, transformersRerankerOptionsSchema, { at: 'createTransformersReranker options' });
  const id = options.id ?? BGE_ID;
  const facts = RERANK_FACTS[id];
  const kind = facts?.kind ?? 'cross-encoder';
  const revision = options.revision ?? facts?.revision ?? 'main';
  const log = getLogger('arki:embeddings');
  const limit = options.maxInputTokens ?? 1024;

  let transformers: typeof Transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch {
    return ModelUnavailable({ model: id, reason: 'peer-missing' });
  }
  const started = performance.now();
  log.debug('transformers loading reranker {model}@{revision}', { model: id, revision });
  const shared = {
    revision,
    ...(options.cacheDir === undefined ? {} : { cache_dir: options.cacheDir }),
    ...(options.onProgress === undefined ? {} : { progress_callback: options.onProgress }),
  };
  const modelOptions = {
    ...shared,
    dtype: options.dtype ?? 'q8',
    ...(options.device === undefined ? {} : { device: options.device }),
  };
  let tokenizer: Awaited<ReturnType<typeof transformers.AutoTokenizer.from_pretrained>>;
  let model: Awaited<ReturnType<typeof transformers.AutoModelForSequenceClassification.from_pretrained>>;
  try {
    tokenizer = await transformers.AutoTokenizer.from_pretrained(id, shared);
    model =
      kind === 'qwen3'
        ? await transformers.AutoModelForCausalLM.from_pretrained(id, modelOptions)
        : await transformers.AutoModelForSequenceClassification.from_pretrained(id, modelOptions);
  } catch (error) {
    log.debug('transformers could not load reranker {model}: {error}', {
      model: id,
      error: error instanceof Error ? error.message : String(error),
    });
    const missing = error instanceof transformers.ModelFileNotFoundError;
    return ModelUnavailable({ model: id, reason: missing ? 'unknown-model' : 'unreachable' });
  }

  const countTokens = (text: string) => tokenizer.encode(text, { add_special_tokens: false }).length;
  const instruction = options.instruction ?? QWEN3_DEFAULT_INSTRUCTION;
  // What the prompt or special tokens take of a pair, so `maxInputTokens` is what query and document get.
  const overhead =
    kind === 'qwen3'
      ? countTokens(qwen3Prompt(instruction, '', ''))
      : tokenizer.encode('a', { text_pair: 'b' }).length - countTokens('a') - countTokens('b');
  const room = limit - overhead;

  const countAll = (query: string, documents: readonly string[]): Counts => ({
    query: countTokens(query),
    documents: documents.map(document => countTokens(document)),
  });
  const tooLong = (counts: Counts) => {
    for (const [index, tokens] of counts.documents.entries()) {
      const count = counts.query + tokens;
      if (count > room) return InputTooLong({ index, tokens: { basis: 'counted', count }, max: room });
    }
    return;
  };

  const crossEncoder: Scorer = async (query, documents, counts, truncate) => {
    const refused = truncate ? undefined : tooLong(counts);
    if (refused) return refused;
    try {
      const encoding = tokenizer(
        documents.map(() => query),
        { text_pair: [...documents], padding: true, truncation: true, max_length: limit },
      );
      const output = classifierSchema.safeParse(await model(encoding));
      if (!output.success || output.data.logits.dims[0] !== documents.length) {
        return InvalidOutput({ reason: `${id} is not a one-logit cross-encoder` });
      }
      return Array.from(output.data.logits.data, logit => sigmoid(logit));
    } catch (error) {
      return InvalidOutput({ reason: `transformers.js failed: ${error instanceof Error ? error.message : 'unknown'}` });
    }
  };

  const yes = tokenIdSchema.safeParse(tokenizer.convert_tokens_to_ids('yes'));
  const no = tokenIdSchema.safeParse(tokenizer.convert_tokens_to_ids('no'));
  const qwen3: Scorer = async (query, documents, counts, truncate, signal) => {
    const refused = truncate ? undefined : tooLong(counts);
    if (refused) return refused;
    if (!yes.success || !no.success) return InvalidOutput({ reason: `${id} has no "yes" or "no" token` });
    const scores: number[] = [];
    const keep = Math.max(0, room - counts.query);
    for (const [index, document] of documents.entries()) {
      if (signal?.aborted) return Cancelled();
      // Cut the document, not the prompt: a cut prompt loses the suffix the answer is read after.
      const fitted =
        (counts.documents[index] ?? 0) > keep
          ? tokenizer.decode(tokenizer.encode(document, { add_special_tokens: false }).slice(0, keep), {
              skip_special_tokens: true,
            })
          : document;
      try {
        const output = causalSchema.safeParse(await model(tokenizer(qwen3Prompt(instruction, query, fitted))));
        if (!output.success) return InvalidOutput({ reason: `${id} answered no causal-LM logits` });
        const [, positions, vocabulary] = output.data.logits.dims;
        const last = (positions - 1) * vocabulary;
        const yesLogit = output.data.logits.data[last + yes.data] ?? Number.NaN;
        const noLogit = output.data.logits.data[last + no.data] ?? Number.NaN;
        // exp(yes) / (exp(yes) + exp(no)), written so a large logit cannot overflow.
        scores.push(sigmoid(yesLogit - noLogit));
      } catch (error) {
        return InvalidOutput({
          reason: `transformers.js failed: ${error instanceof Error ? error.message : 'unknown'}`,
        });
      }
    }
    return scores;
  };

  const score = kind === 'qwen3' ? qwen3 : crossEncoder;
  const probe = await score('probe', ['probe'], countAll('probe', ['probe']), false);
  if (isFailure(probe) || probe.some(value => !Number.isFinite(value))) {
    await model.dispose();
    return isFailure(probe) && InvalidOutput.is(probe)
      ? probe
      : InvalidOutput({ reason: `${id} failed its probe pair` });
  }
  let loadMs: number | undefined = performance.now() - started;
  log.debug('transformers loaded reranker {model} in {loadMs} ms', { model: id, loadMs });

  let disposed = false;
  const rerank: Reranker['rerank'] = async (query, documents, { truncate, signal }) => {
    invariant(!disposed, `transformers reranker ${id} was used after dispose()`);
    if (signal?.aborted) return Cancelled();
    if (documents.length > MAX_DOCUMENTS) return UnsupportedInput({ index: MAX_DOCUMENTS, part: 'batch' });
    const counts = countAll(query, documents);
    const scores = await score(query, documents, counts, truncate === true, signal);
    // Inference cannot be interrupted; a call aborted meanwhile is still cancelled.
    if (signal?.aborted) return Cancelled();
    if (isFailure(scores)) return scores;
    const hits: RerankHit[] = scores
      .map((value, index) => ({ index, score: value }))
      .sort((left, right) => right.score - left.score);
    const tokens = counts.documents.reduce((total, count) => total + overhead + counts.query + count, 0);
    // The load is reported once, by the first call.
    const reported = loadMs;
    loadMs = undefined;
    return {
      hits,
      usage: {
        tokens: { basis: 'counted', count: tokens },
        requests: 1,
        cacheHits: 0,
        ...(reported === undefined ? {} : { loadMs: reported }),
      },
    };
  };

  return {
    provider: 'transformers',
    id,
    revision,
    local: true,
    maxDocuments: MAX_DOCUMENTS,
    maxInputTokens: room,
    countTokens,
    rerank,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await model.dispose();
    },
  };
}
