import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { embedMany } from '../embed.js';
import { createEmbedder } from '../embedder.js';
import { norm } from '../vector.js';
import { createOllamaModel } from './index.js';

// Opt-in: needs a local Ollama with qwen3-embedding:0.6b pulled. Run with OLLAMA_LIVE=1.
describe.skipIf(process.env['OLLAMA_LIVE'] !== '1')('./ollama live', () => {
  it('one real embed of two strings returns 1024 dims, unit norm', async () => {
    const model = createOllamaModel({ ...(process.env['OLLAMA_BASE_URL'] ? { baseURL: process.env['OLLAMA_BASE_URL'] } : {}) });
    if (isFailure(model)) throw new Error(model.message);
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);
    const batch = await embedMany(embedder, ['the rain in Spain', 'ploaia din Spania']);
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.vectors).toHaveLength(2);
    for (const vector of batch.vectors) {
      expect(vector).toHaveLength(1024);
      expect(norm(vector)).toBeCloseTo(1, 3);
    }
    expect(batch.space.revision).toMatch(/^[0-9a-f]{12,}$/);
  });
});
