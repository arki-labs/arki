/**
 * Reranker factory — single dispatch point for all rerankers.
 *
 * Mirrors the pattern of `embeddings/factory.ts`. Each branch is a lightweight
 * constructor call; heavy SDKs are lazy-loaded inside their respective
 * implementations.
 */

import { ConfigurationError } from '../../errors';
import { debugEmbeddings } from '../../debug.ts';

import { CohereReranker  } from './cohere';
import type {CohereRerankerConfig} from './cohere';
import { VoyageReranker  } from './voyage';
import type {VoyageRerankerConfig} from './voyage';
import { JinaReranker  } from './jina';
import type {JinaRerankerConfig} from './jina';
import { TeiReranker  } from './tei';
import type {TeiRerankerConfig} from './tei';
import { MixedbreadReranker  } from './mixedbread';
import type {MixedbreadRerankerConfig} from './mixedbread';
import { BedrockReranker  } from './bedrock';
import type {BedrockRerankerConfig} from './bedrock';
import type { Reranker } from './types';

export type RerankerType =
  | 'cohere'
  | 'voyage'
  | 'jina'
  | 'tei'
  | 'mixedbread'
  | 'bedrock';

export type RerankerConfig =
  | { type: 'cohere'; config?: CohereRerankerConfig }
  | { type: 'voyage'; config?: VoyageRerankerConfig }
  | { type: 'jina'; config?: JinaRerankerConfig }
  | { type: 'tei'; config: TeiRerankerConfig }
  | { type: 'mixedbread'; config?: MixedbreadRerankerConfig }
  | { type: 'bedrock'; config?: BedrockRerankerConfig };

export function createReranker(config: RerankerConfig): Reranker {
  debugEmbeddings('[Rerankers/Factory] creating (type: %s)', config.type);

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
      throw new ConfigurationError(
        `Unknown reranker type: ${(_exhaustive as { type: string }).type}`,
      );
    }
  }
}
