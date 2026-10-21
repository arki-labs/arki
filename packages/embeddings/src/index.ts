/**
 * `@arki/embeddings`: text → vectors behind one `Embedder` shape. Validated output, failures as
 * values. The root imports no provider SDK, no `process.env` and no `node:*`.
 */
export type {
  CacheStore,
  EmbedInput,
  EmbedMiddleware,
  EmbedOptions,
  Embedder,
  Embedding,
  EmbeddingBatch,
  EmbeddingModel,
  EmbeddingModelRef,
  EmbeddingProviderName,
  EmbeddingSpace,
  EmbeddingsLogger,
  EnvSource,
  Instruction,
  NativeEmbeddings,
  NativeRequest,
  Purpose,
  Quantization,
  TokenCount,
  Usage,
} from './types.js';
export type { EmbedderOptions } from './embedder.js';
export type { EmbedManyOptions } from './embed.js';
export {
  Cancelled,
  ConfigurationFailure,
  InputTooLong,
  InvalidOutput,
  ModelUnavailable,
  RateLimited,
  SpaceMismatch,
  UnsupportedInput,
  isEmbedFailure,
} from './failures.js';
export type { EmbedFailure } from './failures.js';
export { isSameSpace, spaceId } from './space.js';
export { createEmbedder } from './embedder.js';
export { embed, embedMany } from './embed.js';
export { resolveEmbeddingModel } from './resolve.js';
export {
  E5_INSTRUCTION,
  EMBEDDINGGEMMA_INSTRUCTION,
  NO_INSTRUCTION,
  NOMIC_INSTRUCTION,
  QWEN3_INSTRUCTION,
} from './instructions.js';
export { cosine, l2Normalize, norm } from './vector.js';
export { countTokens } from './tokens.js';
export { normalizeText } from './normalize.js';
export type { NormalizeTextOptions } from './normalize.js';
export { withMiddleware } from './middleware.js';
export { withResilience } from './resilience.js';
