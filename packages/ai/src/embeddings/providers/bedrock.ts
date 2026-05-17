/**
 * AWS Bedrock embedding provider (Titan Text Embeddings v2).
 *
 * Backed by `@ai-sdk/amazon-bedrock`. Default model
 * `amazon.titan-embed-text-v2:0` (1024-d MRL → 256, 8K ctx, $0.02/M per AWS).
 *
 * Credentials follow the AWS SDK chain (environment, ~/.aws/credentials,
 * IAM role, etc.); explicit `accessKeyId`/`secretAccessKey` are accepted.
 *
 * Lazy-loaded via dynamic import — `@ai-sdk/amazon-bedrock` pulls in heavy
 * AWS signer dependencies that we do not want in apps that don't use Bedrock.
 */

import { AiSdkEmbeddingProvider } from './ai-sdk';
import type { BaseEmbeddingConfig } from '../base';

export type BedrockEmbeddingConfig = BaseEmbeddingConfig & {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** e.g. `amazon.titan-embed-text-v2:0`, `cohere.embed-english-v3`. */
  model?: string;
  /** Output dimensions (Titan v2 MRL: 256, 512, 1024). Default 1024. */
  dimensions?: number;
};

const DEFAULT_MODEL = 'amazon.titan-embed-text-v2:0';
const DEFAULT_DIMS = 1024;

/**
 * Factory function for Bedrock (async because the SDK loads dynamically).
 * Apps that don't use Bedrock won't pay the AWS-signer-import cost.
 */
export async function createBedrockEmbeddingProvider(
  config: BedrockEmbeddingConfig = {},
): Promise<AiSdkEmbeddingProvider> {
  // @ts-expect-error - optional peer dependency
  const { createAmazonBedrock } = await import('@ai-sdk/amazon-bedrock');
  const bedrock = createAmazonBedrock({
    region: config.region ?? process.env['AWS_REGION'] ?? 'us-east-1',
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
  });
  return new AiSdkEmbeddingProvider({
    ...config,
    label: 'bedrock',
    model: bedrock.embedding(config.model ?? DEFAULT_MODEL),
    dimensions: config.dimensions ?? DEFAULT_DIMS,
  });
}
