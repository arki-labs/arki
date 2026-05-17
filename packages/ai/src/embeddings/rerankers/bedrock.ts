/**
 * AWS Bedrock reranker.
 *
 * Uses AI SDK v6's native `rerank()` (Bedrock is in the v6 allow-list along
 * with Cohere and Together.ai). Bedrock surfaces Cohere Rerank under
 * `cohere.rerank-v3-5:0` and other model ids — choose per your account
 * access.
 *
 * Lazy-loaded — `@ai-sdk/amazon-bedrock` pulls in the AWS signer chain.
 */

import { rerank } from 'ai';

import type { Reranker, RerankOptions, RerankResult } from './types';

export type BedrockRerankerConfig = {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** e.g. `cohere.rerank-v3-5:0`, `amazon.rerank-v1:0`. */
  model?: string;
};

const DEFAULT_MODEL = 'cohere.rerank-v3-5:0';

export class BedrockReranker implements Reranker {
  private readonly model: string;
  private readonly config: BedrockRerankerConfig;
  private modelPromise: Promise<unknown> | null = null;

  constructor(config: BedrockRerankerConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.config = config;
  }

  getModel(): string {
    return this.model;
  }

  async rerank(
    query: string,
    documents: string[],
    options: RerankOptions = {},
  ): Promise<RerankResult[]> {
    const model = await this.getModel_();
    const result = await rerank({
      // The bedrock client returns a model with the AI SDK reranking shape.
      model: model as Parameters<typeof rerank>[0]['model'],
      query,
      documents,
      topN: options.topK,
    });
    return result.ranking.map((r) => {
      const out: RerankResult = { index: r.originalIndex, score: r.score };
      if (options.returnDocuments) out.document = r.document;
      return out;
    });
  }

  private async getModel_() {
    if (!this.modelPromise) {
      this.modelPromise = (async () => {
        // @ts-expect-error - optional peer dependency
        const { createAmazonBedrock } = await import('@ai-sdk/amazon-bedrock');
        const bedrock = createAmazonBedrock({
          region: this.config.region ?? process.env['AWS_REGION'] ?? 'us-east-1',
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
          sessionToken: this.config.sessionToken,
        });
        // The AI SDK Bedrock provider exposes reranking at runtime.
        const factory = (bedrock as unknown as { reranking?: (id: string) => unknown }).reranking;
        if (!factory) {
          throw new Error(
            '@ai-sdk/amazon-bedrock does not expose a reranking factory in this version.',
          );
        }
        return factory.call(bedrock, this.model);
      })();
    }
    return this.modelPromise;
  }
}
