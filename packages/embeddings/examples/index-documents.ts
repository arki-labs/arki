import { isFailure } from '@arki/failure';

import type { Embedder, EmbeddingSpace, EnvSource } from '../src/index.js';
import { createEmbedder, embedMany, isSameSpace, resolveEmbeddingModel, SpaceMismatch } from '../src/index.js';

// #region embed-documents
/** Picks the model from the environment, then embeds every text. The first failure comes back as the value. */
export async function embedDocuments(texts: readonly string[], env: EnvSource) {
  const model = resolveEmbeddingModel(undefined, env); // ollama → openai → voyage → google
  if (isFailure(model)) return model;
  const embedder = createEmbedder(model);
  if (isFailure(embedder)) return embedder;
  return embedMany(embedder, texts, { purpose: 'document' });
}
// #endregion

// #region embed-for-index
/** Refuses to add vectors to an index that was built in another space. Nothing is sent to the provider then. */
export async function embedForIndex(embedder: Embedder, texts: readonly string[], indexSpace: EmbeddingSpace) {
  if (!isSameSpace(embedder.space, indexSpace)) return SpaceMismatch({ expected: indexSpace, actual: embedder.space });
  return embedMany(embedder, texts, { purpose: 'document' });
}
// #endregion
