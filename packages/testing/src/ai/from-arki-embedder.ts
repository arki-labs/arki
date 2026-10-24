import type { Embedder } from './judge.js';

/** The one place the optional peer is loaded; also the source of the `Embedder` type, so it is not restated. */
const loadEmbeddings = () => import('@arki/embeddings');

type ArkiEmbedder = Parameters<Awaited<ReturnType<typeof loadEmbeddings>>['embedMany']>[0];

/**
 * Lets any `@arki/embeddings` embedder feed the judge and `similarTo`. Texts go in as
 * `purpose: 'document'`, because both sides of a similarity check are the same kind of text.
 * A failure value becomes a thrown `Error` with the failure's message: a judge cannot go on
 * without vectors.
 *
 * `@arki/embeddings` is an optional peer, loaded on the first `embed` call, so the rest of
 * `@arki/testing/ai` works without it installed.
 *
 * @example
 * const embedder = fromArkiEmbedder(fakeEmbedder({ dimensions: 16 }));
 */
export function fromArkiEmbedder(embedder: ArkiEmbedder): Embedder {
  return {
    model: embedder.space.model,
    async embed(texts) {
      const { embedMany, isEmbedFailure } = await loadEmbeddings();
      const batch = await embedMany(embedder, texts, { purpose: 'document' });
      if (isEmbedFailure(batch)) throw new Error(batch.message);
      return batch.vectors.map(vector => [...vector]);
    },
  };
}
