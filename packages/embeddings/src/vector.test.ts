import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { stubModel, echoTexts } from './tests/stub-model.js';
import { cosine, norm, truncate } from './vector.js';

const matryoshka = stubModel(echoTexts, { dimensions: 4, matryoshka: [4, 2] });

describe('truncate', () => {
  // A prefix of a model not trained for it loses most of its meaning; refusing is the only safe answer.
  it('refuses dims outside matryoshka', () => {
    const refused = truncate(Float32Array.of(0.5, 0.5, 0.5, 0.5), 3, matryoshka);
    expect(isFailure(refused) && refused.data).toEqual({ index: -1, part: 'dimensions' });
    const none = truncate(Float32Array.of(0.5, 0.5, 0.5, 0.5), 2, stubModel(echoTexts, { matryoshka: [] }));
    expect(isFailure(none) && none.data.part).toBe('dimensions');
  });

  // An index of unit vectors scores by dot product; a short prefix that is not re-normalised ranks wrong.
  it('re-normalises after truncation', () => {
    const short = truncate(Float32Array.of(0.6, 0, 0.8, 0), 2, matryoshka);
    if (isFailure(short)) throw new Error(short.message);
    expect([...short]).toEqual([1, 0]);
    expect(norm(short)).toBeCloseTo(1, 6);
  });

  it('keeps raw values for a model whose vectors are not normalised', () => {
    const raw = truncate(Float32Array.of(3, 4, 5, 6), 2, stubModel(echoTexts, { normalized: false }));
    if (isFailure(raw)) throw new Error(raw.message);
    expect([...raw]).toEqual([3, 4]);
  });
});

describe('cosine', () => {
  // A prefix score of vectors from two different spaces looks plausible and is wrong; refusing is the only honest answer.
  it('refuses vectors of different lengths instead of scoring a prefix', () => {
    expect(() => cosine(Float32Array.of(1, 0, 0), Float32Array.of(1, 0))).toThrow(/one length/);
  });

  it('scores vectors of one length', () => {
    expect(cosine(Float32Array.of(1, 0), Float32Array.of(0, 1))).toBe(0);
    expect(cosine(Float32Array.of(1, 2), Float32Array.of(1, 2))).toBe(1);
  });
});
