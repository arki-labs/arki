/**
 * Rerankers — cross-encoder re-ranking after dense retrieval.
 *
 * The recommendation-grid winners per the STATE-OF-THE-ART survey:
 *   - Cohere Rerank 3.5         — cloud default below ~1M queries/mo
 *   - mxbai-rerank-large-v2     — self-host via TEI above 1M queries/mo
 *   - Voyage Rerank 2.5         — strong long-context (32K), instruction-aware
 *   - Jina Reranker v2          — multilingual, CC-BY-NC weights → hosted API
 *   - Qwen3-Reranker            — Apache 2.0 self-host via TEI
 *   - BGE Reranker v2 m3/gemma  — Apache 2.0 self-host via TEI
 */

export type { Reranker, RerankResult, RerankOptions } from './types';

export { CohereReranker, type CohereRerankerConfig } from './cohere';
export { VoyageReranker, type VoyageRerankerConfig } from './voyage';
export { JinaReranker, type JinaRerankerConfig } from './jina';
export { TeiReranker, type TeiRerankerConfig } from './tei';
export { MixedbreadReranker, type MixedbreadRerankerConfig } from './mixedbread';
export { BedrockReranker, type BedrockRerankerConfig } from './bedrock';

export {
  createReranker,
  type RerankerType,
  type RerankerConfig,
} from './factory';
