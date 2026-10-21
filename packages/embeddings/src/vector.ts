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
 * Cosine similarity, for tests and rescoring, not search. Two zero vectors answer 0.
 *
 * @example
 * cosine(Float32Array.of(1, 0), Float32Array.of(0, 1)); // 0
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
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
