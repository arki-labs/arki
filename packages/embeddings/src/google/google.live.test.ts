import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { embedMany } from '../embed.js';
import { createEmbedder } from '../embedder.js';
import { norm } from '../vector.js';
import { createGoogleModel } from './index.js';

// Opt-in: needs GOOGLE_GENERATIVE_AI_API_KEY. Run with GOOGLE_LIVE=1.
describe.skipIf(process.env['GOOGLE_LIVE'] !== '1')('./google live', () => {
  it('one real embed of two strings returns 3072 dims, unit norm, and 768 dims when asked', async () => {
    const model = createGoogleModel({ apiKey: process.env['GOOGLE_GENERATIVE_AI_API_KEY'] ?? '' });
    if (isFailure(model)) throw new Error(model.message);
    const full = createEmbedder(model);
    if (isFailure(full)) throw new Error(full.message);
    const batch = await embedMany(full, ['the rain in Spain', 'ploaia din Spania'], { purpose: 'document' });
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.vectors).toHaveLength(2);
    for (const vector of batch.vectors) {
      expect(vector).toHaveLength(3072);
      expect(norm(vector)).toBeCloseTo(1, 3);
    }
    const small = createEmbedder(model, { dimensions: 768 });
    if (isFailure(small)) throw new Error(small.message);
    const short = await embedMany(small, ['the rain in Spain']);
    if (isFailure(short)) throw new Error(short.message);
    expect(short.vectors[0]).toHaveLength(768);
    expect(norm(short.vectors[0] ?? new Float32Array())).toBeCloseTo(1, 3);
  });
});
