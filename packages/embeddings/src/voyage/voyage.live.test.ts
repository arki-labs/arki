import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { embed, embedMany } from '../embed.js';
import { createEmbedder } from '../embedder.js';
import { hamming, quantize } from '../quantize.js';
import { norm } from '../vector.js';
import { createVoyageModel } from './index.js';

// A 1x1 white PNG.
const PIXEL = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  char => char.codePointAt(0) ?? 0,
);

// Opt-in: spends a few tokens on the real API. Run with VOYAGE_LIVE=1 and VOYAGE_API_KEY set.
describe.skipIf(process.env['VOYAGE_LIVE'] !== '1')('./voyage live', () => {
  it('one real embed of two strings returns 1024 dims, unit norm', async () => {
    const model = createVoyageModel({ apiKey: process.env['VOYAGE_API_KEY'] ?? '' });
    if (isFailure(model)) throw new Error(model.message);
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);
    const batch = await embedMany(embedder, ['the rain in Spain', 'ploaia din Spania'], { purpose: 'document' });
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.vectors).toHaveLength(2);
    for (const vector of batch.vectors) {
      expect(vector).toHaveLength(1024);
      expect(norm(vector)).toBeCloseTo(1, 3);
    }
    expect(batch.usage.tokens.basis).toBe('reported');
  });

  // The provider's packed bits must match our MSB-first packing of its own floats. LSB-first packing
  // would disagree on about half the bits; a few sign flips near 0 are rounding, not order.
  it('native binary uses our bit order', async () => {
    const model = createVoyageModel({ apiKey: process.env['VOYAGE_API_KEY'] ?? '' });
    if (isFailure(model)) throw new Error(model.message);
    const floats = createEmbedder(model);
    const bits = createEmbedder(model, { quantization: 'binary' });
    if (isFailure(floats) || isFailure(bits)) throw new Error('refused');
    const text = 'the rain in Spain stays mainly in the plain';
    const float = await embed(floats, text, { purpose: 'document' });
    const packed = await embed(bits, text, { purpose: 'document' });
    if (isFailure(float) || isFailure(packed)) throw new Error('embed failed');
    if (!(float.vector instanceof Float32Array) || !(packed.vector instanceof Uint8Array)) throw new Error('dtypes');
    const ours = quantize(float.vector, 'binary');
    if (isFailure(ours)) throw new Error(ours.message);
    expect(hamming(ours, packed.vector)).toBeLessThanOrEqual(1024 * 0.02);
  });

  it('one real image embeds with voyage-multimodal-3.5', async () => {
    const model = createVoyageModel({ id: 'voyage-multimodal-3.5', apiKey: process.env['VOYAGE_API_KEY'] ?? '' });
    if (isFailure(model)) throw new Error(model.message);
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);
    const batch = await embedder.embed(['a white pixel', { image: PIXEL }], { purpose: 'document' });
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.vectors).toHaveLength(2);
    expect(batch.vectors[1]).toHaveLength(1024);
  });
});
