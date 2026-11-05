// The opt-in `./transformers` check of `smoke.mjs` (TRANSFORMERS_SMOKE=1), on Node and Bun only. It loads
// EmbeddingGemma (a ~300 MB download, into TRANSFORMERS_CACHE_DIR when set), embeds two texts and prints
// its checks as one JSON line of `[name, actual, expected]` rows for `smoke.mjs` to judge.

import { createEmbedder, embedMany } from '../dist/index.js';
import { createTransformersModel } from '../dist/transformers/index.js';

const cacheDir = process.env.TRANSFORMERS_CACHE_DIR;
const model = await createTransformersModel(cacheDir ? { cacheDir } : {});
const batch = await embedMany(createEmbedder(model), ['the rain in Spain', 'ploaia din Spania']);
await model.dispose?.();
console.log(
  JSON.stringify([
    ['transformers embeds two texts', batch.vectors?.length ?? null, 2],
    ['transformers observes 768 dims', model.dimensions, 768],
  ]),
);
