import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { embedMany } from '../embed.js';
import { createEmbedder } from '../embedder.js';
import { norm } from '../vector.js';
import { createJinaModel } from './index.js';

// Opt-in: spends a few tokens on the real API. Run with JINA_LIVE=1 and JINA_API_KEY set.
describe.skipIf(process.env['JINA_LIVE'] !== '1')('./jina live', () => {
  it('one real embed of two strings returns 1024 dims, unit norm, and 256 dims when asked', async () => {
    const model = createJinaModel({ apiKey: process.env['JINA_API_KEY'] ?? '' });
    if (isFailure(model)) throw new Error(model.message);
    const full = createEmbedder(model);
    if (isFailure(full)) throw new Error(full.message);
    const batch = await embedMany(full, ['the rain in Spain', 'ploaia din Spania'], { purpose: 'document' });
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.vectors).toHaveLength(2);
    for (const vector of batch.vectors) {
      expect(vector).toHaveLength(1024);
      expect(norm(vector)).toBeCloseTo(1, 3);
    }
    expect(batch.usage.tokens.basis).toBe('reported');

    const small = createEmbedder(model, { dimensions: 256 });
    if (isFailure(small)) throw new Error(small.message);
    const short = await embedMany(small, ['the rain in Spain'], { purpose: 'query' });
    if (isFailure(short)) throw new Error(short.message);
    expect(short.vectors[0]).toHaveLength(256);
    expect(norm(short.vectors[0] ?? new Float32Array())).toBeCloseTo(1, 3);
  });
});
