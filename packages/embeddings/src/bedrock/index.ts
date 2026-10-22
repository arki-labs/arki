/**
 * `@arki/embeddings/bedrock`: Amazon Titan Text Embeddings on AWS Bedrock through the AI SDK.
 * Server runtimes only (Node, Bun): the AWS request signing needs `node:crypto`.
 *
 * The SDK peers (`@ai-sdk/amazon-bedrock`, `ai`) are loaded with a dynamic `import()` on the first
 * call, not at import, exactly like `./google`. A missing peer is the value
 * `ModelUnavailable { reason: 'peer-missing' }`, returned by that first call.
 */
import { isFailure } from '@arki/failure';

import type { FetchLike } from '../http.js';
import type { EmbeddingModel, NativeRequest } from '../types.js';
import { Cancelled, ConfigurationFailure, InvalidOutput, ModelUnavailable, RateLimited } from '../failures.js';
import { mentionsContextLength, retryAfterMs } from '../http.js';
import { NO_INSTRUCTION } from '../instructions.js';
import { providerInputTooLong, truncateByEstimate } from '../tokens.js';

export type BedrockModelOptions = {
  /** Default `'amazon.titan-embed-text-v2:0'`. */
  readonly id?: string;
  /** Default: the SDK reads `AWS_REGION`. */
  readonly region?: string;
  /** A Bedrock API key (bearer token). Default: the SDK reads `AWS_BEARER_TOKEN_BEDROCK`. */
  readonly apiKey?: string;
  /** Default: the SDK reads `AWS_ACCESS_KEY_ID`. */
  readonly accessKeyId?: string;
  /** Default: the SDK reads `AWS_SECRET_ACCESS_KEY`. */
  readonly secretAccessKey?: string;
  /** Default: the SDK reads `AWS_SESSION_TOKEN`. */
  readonly sessionToken?: string;
  /** Default: the regional `bedrock-runtime` endpoint. */
  readonly baseURL?: string;
  /** Replaces the global `fetch`; tests inject a stub here. */
  readonly fetch?: FetchLike;
};

/** The sizes Titan V2 accepts, native first. */
const TITAN_SIZES = [1024, 512, 256] as const;

type BedrockFacts = Pick<EmbeddingModel, 'dimensions' | 'matryoshka' | 'maxInputTokens'>;

// https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html (read 2026-10-22):
// Titan Text Embeddings V2 takes up to 8,192 tokens or 50,000 characters and outputs 1,024 (default),
// 512 or 256 dims. The request has `normalize` (default true) and `dimensions`.
const BEDROCK_FACTS: Readonly<Record<string, BedrockFacts>> = {
  'amazon.titan-embed-text-v2:0': { dimensions: 1024, matryoshka: TITAN_SIZES, maxInputTokens: 8192 },
};

/** Titan's wording for an over-long text. Not in the docs, so matched with the shared pattern plus this one. */
const mentionsInputTokens = (text: string): boolean =>
  mentionsContextLength(text) || /too many input tokens/i.test(text);

/** Loads both peers and builds the SDK model once. Any import failure means the peer is not installed. */
async function loadSdk(id: string, options: BedrockModelOptions) {
  try {
    const [{ createAmazonBedrock }, { embedMany, APICallError }] = await Promise.all([
      import('@ai-sdk/amazon-bedrock'),
      import('ai'),
    ]);
    const send = options.fetch;
    const provider = createAmazonBedrock({
      ...(options.region === undefined ? {} : { region: options.region }),
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.accessKeyId === undefined ? {} : { accessKeyId: options.accessKeyId }),
      ...(options.secretAccessKey === undefined ? {} : { secretAccessKey: options.secretAccessKey }),
      ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      // The SDK may hand over a URL or a Request; the narrow stub type wants a string and an init.
      ...(send === undefined
        ? {}
        : {
            fetch: (input: string | URL | Request, init?: RequestInit) => {
              if (typeof input === 'string') return send(input, init ?? {});
              if (input instanceof URL) return send(input.href, init ?? {});
              return send(input.url, { method: input.method, headers: input.headers, body: input.body, ...init });
            },
          }),
    });
    return { model: provider.embeddingModel(id), embedMany, apiCallError: APICallError };
  } catch {
    return ModelUnavailable({ model: id, reason: 'peer-missing' });
  }
}

/**
 * A Bedrock Titan model record. Titan ids are versioned (`:0`), so `assurance` is `immutable`.
 *
 * @example
 * const model = createBedrockModel({ region: 'us-east-1' });
 */
export function createBedrockModel(options: BedrockModelOptions = {}) {
  const id = options.id ?? 'amazon.titan-embed-text-v2:0';
  const facts = BEDROCK_FACTS[id];
  if (facts === undefined) {
    return ConfigurationFailure({
      message: `bedrock model ${id} is not in the facts table (${Object.keys(BEDROCK_FACTS).join(', ')})`,
    });
  }

  let sdk: ReturnType<typeof loadSdk> | undefined;

  const embedTexts = async ({ texts, dimensions, truncate, signal }: NativeRequest) => {
    sdk ??= loadSdk(id, options);
    const loaded = await sdk;
    if (isFailure(loaded)) {
      sdk = undefined;
      return loaded;
    }
    // The SDK's option takes the literal sizes only; `find` hands back the matching literal.
    const size = TITAN_SIZES.find(candidate => candidate === dimensions);
    try {
      const result = await loaded.embedMany({
        model: loaded.model,
        // Titan has no truncate flag: cut at the character estimate of the model's limit.
        values: truncate ? texts.map(text => truncateByEstimate(text, facts.maxInputTokens)) : [...texts],
        // Retries belong to withResilience, where each attempt is charged once.
        maxRetries: 0,
        providerOptions: { bedrock: { normalize: true, ...(size === undefined ? {} : { dimensions: size }) } },
        ...(signal ? { abortSignal: signal } : {}),
      });
      const tokens = result.usage.tokens;
      return {
        vectors: result.embeddings,
        tokens: Number.isFinite(tokens) ? { basis: 'reported' as const, count: tokens } : { basis: 'unknown' as const },
      };
    } catch (error) {
      if (signal?.aborted) return Cancelled();
      if (!loaded.apiCallError.isInstance(error)) {
        // The SDK throws a plain Error before any request when it finds no credentials: not an outage.
        if (error instanceof Error && /AWS SigV4 authentication requires/.test(error.message)) {
          return ConfigurationFailure({ message: `bedrock has no credentials: ${error.message.slice(0, 200)}` });
        }
        return ModelUnavailable({ model: id, reason: 'unreachable' });
      }
      const status = error.statusCode;
      if (status === undefined) return ModelUnavailable({ model: id, reason: 'unreachable' });
      if (status === 429) {
        const wait = retryAfterMs(name => error.responseHeaders?.[name]);
        return RateLimited(wait === undefined ? {} : { retryAfterMs: wait });
      }
      // Bedrock answers 403 for bad credentials and for a model the account has not enabled.
      if (status === 401 || status === 403) {
        return ConfigurationFailure({
          message: `bedrock refused the credentials (${status}): ${error.message.slice(0, 200)}`,
        });
      }
      if (status === 404) return ModelUnavailable({ model: id, reason: 'unknown-model' });
      if (status === 400 && mentionsInputTokens(`${error.message} ${error.responseBody ?? ''}`)) {
        return providerInputTooLong(model, texts);
      }
      return InvalidOutput({ reason: `bedrock answered ${status}: ${error.message.slice(0, 200)}` });
    }
  };

  const model: EmbeddingModel = {
    provider: 'bedrock',
    id,
    assurance: 'immutable',
    local: false,
    ...facts,
    // One text per Titan call: the SDK splits a batch into parallel calls, so keep batches small for the RPM quota.
    maxBatch: 16,
    maxBatchTokens: 16 * facts.maxInputTokens,
    normalized: true,
    instruction: NO_INSTRUCTION,
    inputs: ['text'],
    // Titan's `embeddingTypes: ['binary']` is not reachable through the AI SDK.
    quantizations: [],
    embedTexts,
  };
  return model;
}
