import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { embed, embedMany } from '../embed.js';
import { createEmbedder } from '../embedder.js';
import { cosine, norm } from '../vector.js';
import { createTransformersModel } from './index.js';

// Opt-in: downloads EmbeddingGemma q8 (about 316 MB) on the first run. Run with TRANSFORMERS_LIVE=1;
// TRANSFORMERS_CACHE_DIR keeps the weights outside the repository.
describe.skipIf(process.env['TRANSFORMERS_LIVE'] !== '1')('./transformers live', () => {
  it('real q8 embed: 768 dims, unit norm, and the model card ranking', { timeout: 600_000 }, async () => {
    const cacheDir = process.env['TRANSFORMERS_CACHE_DIR'];
    const model = await createTransformersModel(cacheDir === undefined ? {} : { cacheDir });
    if (isFailure(model)) throw new Error(model.message);
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);

    const documents = [
      'Venus is often called Earth’s twin because of its similar size and proximity.',
      'Mars, known for its reddish appearance, is often referred to as the Red Planet.',
      'Jupiter, the largest planet in our solar system, has a prominent red spot.',
    ];
    const batch = await embedMany(embedder, documents, { purpose: 'document' });
    const query = await embed(embedder, 'Which planet is known as the Red Planet?', { purpose: 'query' });
    if (isFailure(batch)) throw new Error(batch.message);
    if (isFailure(query)) throw new Error(query.message);

    expect(model.dimensions).toBe(768);
    for (const vector of batch.vectors) {
      expect(vector).toHaveLength(768);
      expect(norm(vector)).toBeCloseTo(1, 3);
    }
    const scores = batch.vectors.map(vector =>
      vector instanceof Float32Array && query.vector instanceof Float32Array ? cosine(query.vector, vector) : 0,
    );
    // The card's own example: the Mars document is the best match.
    expect(scores.indexOf(Math.max(...scores))).toBe(1);
    expect(batch.space.revision).toMatch(/^[0-9a-f]{40}$/);
    await model.dispose?.();
  });
});
