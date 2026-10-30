import { invariant } from '@arki/failure';

import type { EmbeddingModel } from './types.js';
import { UnsupportedInput } from './failures.js';

/**
 * Euclidean length.
 *
 * @example
 * norm([3, 4]); // 5
 */
export function norm(vector: Iterable<number>): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

/**
 * Cosine similarity, for tests and rescoring, not search. Two zero vectors answer 0. Vectors of
 * different lengths come from different spaces and score nothing, so that is a caller bug and throws.
 *
 * @example
 * cosine(Float32Array.of(1, 0), Float32Array.of(0, 1)); // 0
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  invariant(a.length === b.length, () => `cosine needs vectors of one length, got ${a.length} and ${b.length}`);
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index++) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  // sqrt(aa * bb), not sqrt(aa) * sqrt(bb): for identical vectors it is exactly aa, so cosine(v, v) is exactly 1.
  const denominator = Math.sqrt(aa * bb);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * A unit-length copy. A zero vector is returned as a zero copy.
 *
 * @example
 * l2Normalize(Float32Array.of(3, 4)); // Float32Array [0.6, 0.8]
 */
export function l2Normalize(vector: Float32Array): Float32Array {
  const length = norm(vector);
  const out = new Float32Array(vector.length);
  if (length === 0) return out;
  for (let index = 0; index < vector.length; index++) out[index] = (vector[index] ?? 0) / length;
  return out;
}

/**
 * The first `dimensions` values of a Matryoshka vector, re-normalised when the model's vectors are
 * unit length. A size the model was not trained to cut to (not its native size, not in
 * `model.matryoshka`) is `UnsupportedInput { part: 'dimensions' }`: a plain prefix of any other
 * model loses most of its meaning.
 *
 * @example
 * const short = truncate(batch.vectors[0], 256, embedder.model); // Float32Array of 256, or UnsupportedInput
 */
export function truncate(vector: Float32Array, dimensions: number, model: EmbeddingModel) {
  const allowed = dimensions === model.dimensions || model.matryoshka.includes(dimensions);
  if (!allowed || dimensions > vector.length) return UnsupportedInput({ index: -1, part: 'dimensions' });
  const prefix = vector.slice(0, dimensions);
  return model.normalized ? l2Normalize(prefix) : prefix;
}
