/**
 * Reranker factory — single dispatch point for all rerankers.
 *
 * Mirrors the pattern of `embeddings/factory.ts`. Each branch is a lightweight
 * constructor call; heavy SDKs are lazy-loaded inside their respective
 * implementations.
 */

import type { BedrockRerankerConfig } from './bedrock';
import type { CohereRerankerConfig } from './cohere';
import type { JinaRerankerConfig } from './jina';
import type { MixedbreadRerankerConfig } from './mixedbread';
import type { TeiRerankerConfig } from './tei';
import type { Reranker } from './types';
import type { VoyageRerankerConfig } from './voyage';
import { debugEmbeddings } from '../../debug.ts';
import { ConfigurationError } from '../../errors';
import { BedrockReranker } from './bedrock';
import { CohereReranker } from './cohere';
import { JinaReranker } from './jina';
import { MixedbreadReranker } from './mixedbread';
import { TeiReranker } from './tei';
import { VoyageReranker } from './voyage';

export type RerankerType = 'cohere' | 'voyage' | 'jina' | 'tei' | 'mixedbread' | 'bedrock';

export type RerankerConfig =
  | { type: 'cohere'; config?: CohereRerankerConfig }
  | { type: 'voyage'; config?: VoyageRerankerConfig }
  | { type: 'jina'; config?: JinaRerankerConfig }
  | { type: 'tei'; config: TeiRerankerConfig }
  | { type: 'mixedbread'; config?: MixedbreadRerankerConfig }
  | { type: 'bedrock'; config?: BedrockRerankerConfig };

export function createReranker(config: RerankerConfig): Reranker {
  debugEmbeddings.debug('[Rerankers/Factory] creating (type: {type})', { type: config.type });

  switch (config.type) {
    case 'cohere': {
      return new CohereReranker(config.config ?? {});
    }
    case 'voyage': {
      return new VoyageReranker(config.config ?? {});
    }
    case 'jina': {
      return new JinaReranker(config.config ?? {});
    }
    case 'tei': {
      return new TeiReranker(config.config);
    }
    case 'mixedbread': {
      return new MixedbreadReranker(config.config ?? {});
    }
    case 'bedrock': {
      return new BedrockReranker(config.config ?? {});
    }
    default: {
      const _exhaustive: never = config;
      throw new ConfigurationError(`Unknown reranker type: ${(_exhaustive as { type: string }).type}`);
    }
  }
}
