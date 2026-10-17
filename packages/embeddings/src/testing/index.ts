/**
 * `@arki/embeddings/testing`: a deterministic fake embedder for tests.
 *
 * NOT semantic. Equal text gives an identical unit vector; different text gives an unrelated one.
 * A test that asserts ranking by meaning passes or fails for the wrong reason with this fake.
 */
import { getLogger } from '@arki/log';

import type { EmbedFailure } from '../failures.js';
import type { Embedder, EmbeddingModel, NativeRequest } from '../types.js';
import { buildEmbedder } from '../embedder.js';
import { Cancelled } from '../failures.js';
import { NO_INSTRUCTION } from '../instructions.js';

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

/** A seeded, deterministic, not-semantic embedder. Its vectors go through the same validation as a real one. */
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
