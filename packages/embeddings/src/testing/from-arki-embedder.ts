import type { Embedder as JudgeEmbedder } from '@arki/testing/ai';

import type { Embedder } from '../types.js';
import { embedMany } from '../embed.js';
import { isEmbedFailure } from '../failures.js';

/**
 * Lets any `@arki/embeddings` embedder feed the `@arki/testing/ai` judge and `similarTo`. Texts
 * go in as `purpose: 'document'`, because both sides of a similarity check are the same kind of
 * text. A failure value becomes a thrown `Error` with the failure's message: a judge cannot go on
 * without vectors.
 *
 * `@arki/testing` is an optional peer, used for its `Embedder` type only, so nothing of it loads
 * at run time.
 *
 * @example
 * const embedder = fromArkiEmbedder(fakeEmbedder({ dimensions: 16 }));
 */
export function fromArkiEmbedder(embedder: Embedder): JudgeEmbedder {
  return {
    model: embedder.space.model,
    async embed(texts) {
      const batch = await embedMany(embedder, texts, { purpose: 'document' });
      if (isEmbedFailure(batch)) throw new Error(batch.message);
      return batch.vectors.map(vector => [...vector]);
    },
  };
}
