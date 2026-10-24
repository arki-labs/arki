/**
 * `@arki/embeddings/testing`: a deterministic fake embedder and fake reranker for tests, and real
 * vectors recorded once and replayed offline. `fromArkiEmbedder` feeds an embedder to the
 * `@arki/testing/ai` judge.
 *
 * The fake is NOT semantic. Equal text gives an identical unit vector; different text gives an
 * unrelated one. A test that asserts ranking by meaning passes or fails for the wrong reason with
 * it; record a real model with `recordEmbedder` and replay it with `fixtureEmbedder` instead.
 */
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { EmbedFailure } from '../failures.js';
import type { EmbedInput, EmbedOptions, Embedder, Embedding, EmbeddingModel, NativeRequest } from '../types.js';
import { buildEmbedder } from '../embedder.js';
import type { Reranker } from '../rerank/index.js';
import { Cancelled, ConfigurationFailure, InputTooLong, InvalidOutput, UnsupportedInput } from '../failures.js';
import { withMiddleware } from '../middleware.js';
import { sha256Hex } from '../sha256.js';
import { isSameSpace } from '../space.js';
import { embedRequestSchema, spaceSchema, tokenCountSchema } from '../schemas.js';
import { NO_INSTRUCTION } from '../instructions.js';

export { fromArkiEmbedder } from './from-arki-embedder.js';

export type FakeEmbedderOptions = {
  readonly dimensions: number;
  /** Different seeds give unrelated vectors for the same text. Default 0. */
  readonly seed?: number;
  /** An input whose exact text is a key fails the whole call with that failure. */
  readonly failures?: Readonly<Record<string, EmbedFailure>>;
  /** Waits this long per call, so concurrency and cancellation are observable. */
  readonly delayMs?: number;
};

/** FNV-1a over the seed and the exact text: the start state of the vector's number stream. */
function hashText(seed: number, text: string): number {
  let hash = (0x81_1C_9D_C5 ^ seed) >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return hash;
}

/** Mulberry32 from `state`, mapped to [-1, 1), then scaled to unit length. Same on every runtime. */
function fakeVector(seed: number, text: string, dimensions: number): Float32Array {
  let state = hashText(seed, text);
  const raw = new Float64Array(dimensions);
  let squares = 0;
  for (let index = 0; index < dimensions; index++) {
    state = (state + 0x6D_2B_79_F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    const value = (((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296) * 2 - 1;
    raw[index] = value;
    squares += value * value;
  }
  const length = Math.sqrt(squares);
  return Float32Array.from(raw, value => value / length);
}

function wait(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, delayMs);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * A seeded, deterministic, not-semantic embedder. Its vectors go through the same validation as a real one.
 *
 * @example
 * const embedder = fakeEmbedder({ dimensions: 8, failures: { 'bad text': RateLimited({}) } });
 */
export function fakeEmbedder(options: FakeEmbedderOptions): Embedder {
  const { dimensions, seed = 0, failures = {}, delayMs = 0 } = options;

  const embedTexts = async ({ texts, signal }: NativeRequest) => {
    if (delayMs > 0) await wait(delayMs, signal);
    if (signal?.aborted) return Cancelled();
    for (const text of texts) {
      const failure = failures[text];
      if (failure !== undefined) return failure;
    }
    return {
      vectors: texts.map(text => fakeVector(seed, text, dimensions)),
      tokens: { basis: 'estimated' as const, count: texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0) },
    };
  };

  const model: EmbeddingModel = {
    provider: 'fake',
    id: `fake-${dimensions}`,
    // The seed changes every vector, so it is part of the space.
    revision: `seed-${seed}`,
    assurance: 'immutable',
    local: true,
    dimensions,
    matryoshka: [],
    maxInputTokens: 1_000_000,
    maxBatch: 2048,
    maxBatchTokens: 1_000_000,
    normalized: true,
    instruction: NO_INSTRUCTION,
    inputs: ['text'],
    quantizations: [],
    embedTexts,
  };
  return buildEmbedder(model, dimensions, 'float32', getLogger('arki:embeddings'));
}

// ---- Recorded fixtures ------------------------------------------------------------------------

/** One recorded call. `request` is kept for people reading the file; `key` is what replay matches. */
const recordingSchema = z.object({
  key: z.string(),
  request: embedRequestSchema,
  /** The model's limits, so `embedMany` splits a replayed corpus into the same calls it recorded. */
  limits: z.object({
    maxInputTokens: z.number().int().positive(),
    maxBatch: z.number().int().positive(),
    maxBatchTokens: z.number().int().positive(),
  }),
  vectors: z.array(z.array(z.number())),
  space: spaceSchema,
  /** The embedder's own space (no per-call options), for replay's `space` and `spaceFor({})`. */
  defaultSpace: spaceSchema,
  tokens: tokenCountSchema,
});

type Recording = z.output<typeof recordingSchema>;

/** Text inputs only: an image input has no stable JSON form here, so such a call is not recorded. */
function textsOf(inputs: readonly EmbedInput[]): string[] | undefined {
  const texts: string[] = [];
  for (const input of inputs) {
    if (typeof input !== 'string') return undefined;
    texts.push(input);
  }
  return texts;
}

/** The request as replay matches it: everything that changes the answer, nothing else. */
function requestOf(texts: readonly string[], options: EmbedOptions): Recording['request'] {
  return {
    inputs: [...texts],
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
    ...(options.quantization === undefined ? {} : { quantization: options.quantization }),
    ...(options.onTooLong === undefined ? {} : { onTooLong: options.onTooLong }),
  };
}

function keyOf(request: Recording['request']): string {
  const material = JSON.stringify([
    request.inputs,
    request.purpose ?? '',
    request.dimensions ?? 0,
    request.quantization ?? '',
    request.onTooLong ?? 'fail',
  ]);
  return sha256Hex(new TextEncoder().encode(material));
}

/**
 * The same embedder, writing every successful text-only call to `path` as JSON: one array of
 * `{ key, request, limits, vectors, space, tokens }`, rewritten after each call. A recording run
 * starts a fresh file. Node, Bun and Deno only (it writes with `node:fs`); replay runs anywhere.
 *
 * @example
 * const recorder = recordEmbedder(createEmbedder(model), '__fixtures__/qwen3.json');
 * await embedMany(recorder, corpus); // run once against the real model, commit the file
 */
export function recordEmbedder(embedder: Embedder, path: string): Embedder {
  const recordings: Recording[] = [];
  let writing: Promise<void> = Promise.resolve();
  const write = async (): Promise<void> => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, `${JSON.stringify(recordings, undefined, 2)}\n`);
  };
  const save = (): Promise<void> => {
    // One write at a time, in call order, so the file always holds every finished call. A failed
    // write is reported to its own call; the next call writes again whether the last one failed or not.
    writing = writing.then(write, write);
    return writing;
  };
  return withMiddleware(embedder, next => async (inputs, options) => {
    const result = await next(inputs, options);
    const texts = textsOf(inputs);
    if (isFailure(result) || texts === undefined) return result;
    const request = requestOf(texts, options);
    const { maxInputTokens, maxBatch, maxBatchTokens } = embedder.model;
    recordings.push({
      key: keyOf(request),
      request,
      limits: { maxInputTokens, maxBatch, maxBatchTokens },
      vectors: result.vectors.map(vector => [...vector]),
      space: result.space,
      defaultSpace: embedder.space,
      tokens: result.usage.tokens,
    });
    try {
      await save();
    } catch (error) {
      // An embedder never throws: a path that cannot be written is the caller's configuration.
      return ConfigurationFailure({ message: `could not write the recording to ${path}: ${String(error)}` });
    }
    return result;
  });
}

/** A recorded vector back in its space's typed array, or `undefined` when its length does not fit. */
function vectorOf(values: readonly number[], space: Recording['space']): Embedding['vector'] | undefined {
  if (space.quantization === 'binary') {
    return values.length === Math.ceil(space.dimensions / 8) ? Uint8Array.from(values) : undefined;
  }
  if (values.length !== space.dimensions) return undefined;
  return space.quantization === 'int8' ? Int8Array.from(values) : Float32Array.from(values);
}

/**
 * An embedder that answers only from recordings made by `recordEmbedder` (the parsed file). A
 * request that was not recorded is `InvalidOutput { reason: 'no fixture …' }`, never a made-up
 * vector. A file that does not parse, is empty, or mixes spaces is `ConfigurationFailure`.
 *
 * @example
 * const embedder = fixtureEmbedder(JSON.parse(readFileSync('__fixtures__/qwen3.json', 'utf8')));
 */
export function fixtureEmbedder(recordings: unknown) {
  const parsed = z.array(recordingSchema).min(1).safeParse(recordings);
  if (!parsed.success) return ConfigurationFailure({ message: `not a recording file: ${parsed.error.message}` });
  const [first] = parsed.data;
  if (first === undefined) return ConfigurationFailure({ message: 'not a recording file: no recordings' });
  const base = first.defaultSpace;
  const byKey = new Map<string, Recording>();
  for (const recording of parsed.data) {
    // Dimensions and dtype may differ per call; the model, revision and instructions may not.
    const sameModel = isSameSpace(
      { ...recording.space, dimensions: base.dimensions, quantization: base.quantization, calibration: base.calibration },
      base,
    );
    if (!sameModel) return ConfigurationFailure({ message: 'a recording file must hold one model' });
    byKey.set(recording.key, recording);
  }

  const model: EmbeddingModel = {
    provider: base.provider,
    id: base.model,
    ...(base.revision === undefined ? {} : { revision: base.revision }),
    assurance: 'immutable',
    local: true,
    dimensions: base.dimensions,
    matryoshka: [],
    ...first.limits,
    normalized: base.normalized,
    instruction: { version: base.instructionVersion },
    inputs: ['text'],
    quantizations: [],
    // Replay answers whole calls in `embed`; a native call has no recording to match.
    embedTexts: () => Promise.resolve(InvalidOutput({ reason: 'no fixture: replay answers whole embed calls only' })),
  };

  const embed = (inputs: readonly EmbedInput[], options: EmbedOptions) => {
    // Replay behaves like a live embedder here too, or a cancellation test passes only offline.
    if (options.signal?.aborted) return Promise.resolve(Cancelled());
    const texts = textsOf(inputs);
    const recording = texts === undefined ? undefined : byKey.get(keyOf(requestOf(texts, options)));
    if (recording === undefined) return Promise.resolve(InvalidOutput({ reason: 'no fixture for this request' }));
    const vectors: Embedding['vector'][] = [];
    for (const values of recording.vectors) {
      const vector = vectorOf(values, recording.space);
      if (vector === undefined) return Promise.resolve(InvalidOutput({ reason: 'fixture vector does not fit its space' }));
      vectors.push(vector);
    }
    return Promise.resolve({
      vectors,
      space: recording.space,
      usage: { tokens: recording.tokens, requests: 1, cacheHits: 0 },
    });
  };

  return {
    model,
    space: base,
    // The space a recorded call with these options answered in; the embedder's own otherwise.
    spaceFor: options =>
      parsed.data.find(
        recording =>
          recording.request.dimensions === options.dimensions && recording.request.quantization === options.quantization,
      )?.space ?? base,
    embed,
  } satisfies Embedder;
}

export type FakeRerankerOptions = {
  /** A fixed score per exact document text. Any other document gets a seeded score in [0, 1). */
  readonly scores?: Readonly<Record<string, number>>;
  /** Different seeds give unrelated scores for the same pair. Default 0. */
  readonly seed?: number;
  /** Default 1000. */
  readonly maxDocuments?: number;
  /** Default 512, counted as `rerank()` estimates without a tokenizer: characters / 4. */
  readonly maxInputTokens?: number;
};

/** Tokens as `rerank()` estimates them without a tokenizer. */
const estimate = (text: string) => Math.ceil(text.length / 4);

/**
 * A seeded, deterministic, not-semantic reranker. Like a real one it refuses more than
 * `maxDocuments` documents and, unless told to truncate, a query and document over `maxInputTokens`.
 *
 * @example
 * const reranker = fakeReranker({ scores: { 'the answer': 0.9 }, maxDocuments: 2 });
 */
export function fakeReranker(options: FakeRerankerOptions = {}): Reranker {
  const { scores = {}, seed = 0, maxDocuments = 1000, maxInputTokens = 512 } = options;
  const scoreOf = (query: string, document: string) =>
    Object.hasOwn(scores, document) ? (scores[document] ?? 0) : hashText(seed, `${query}\u0000${document}`) / 4_294_967_296;
  return {
    provider: 'fake',
    id: 'fake-reranker',
    local: true,
    maxDocuments,
    maxInputTokens,
    rerank(query, documents, { truncate, signal }) {
      if (signal?.aborted) return Promise.resolve(Cancelled());
      if (documents.length > maxDocuments) return Promise.resolve(UnsupportedInput({ index: maxDocuments, part: 'batch' }));
      for (const [index, document] of documents.entries()) {
        const count = estimate(query) + estimate(document);
        if (truncate !== true && count > maxInputTokens) {
          return Promise.resolve(InputTooLong({ index, tokens: { basis: 'estimated', count }, max: maxInputTokens }));
        }
      }
      const hits = documents
        .map((document, index) => ({ index, score: scoreOf(query, document) }))
        .sort((left, right) => right.score - left.score);
      return Promise.resolve({ hits, usage: { tokens: { basis: 'unknown' }, requests: 1, cacheHits: 0 } });
    },
  };
}
