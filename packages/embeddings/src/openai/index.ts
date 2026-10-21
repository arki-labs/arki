/**
 * `@arki/embeddings/openai`: OpenAI embedding models through the AI SDK.
 *
 * The SDK peers (`@ai-sdk/openai`, `ai`) are loaded with a dynamic `import()` on the first call, not
 * at import. That is what lets the pure root `resolveEmbeddingModel` build an OpenAI record without
 * the root ever naming an SDK type or requiring the peer to be installed. A missing peer is the
 * value `ModelUnavailable { reason: 'peer-missing' }`, returned by that first call.
 */
import { isFailure } from '@arki/failure';

import type { EmbeddingModel, NativeRequest } from '../types.js';
import { Cancelled, ConfigurationFailure, InvalidOutput, ModelUnavailable, RateLimited } from '../failures.js';
import { mentionsContextLength, retryAfterMs } from '../http.js';
import { NO_INSTRUCTION } from '../instructions.js';
import { CHARS_PER_TOKEN, providerInputTooLong } from '../tokens.js';

export type OpenAIModelOptions = {
  /** Default `'text-embedding-3-small'`. */
  readonly id?: string;
  readonly apiKey: string;
  /** An OpenAI-compatible base URL, e.g. a proxy. Default: the SDK's. */
  readonly baseURL?: string;
};

type OpenAIFacts = Pick<EmbeddingModel, 'dimensions' | 'matryoshka' | 'maxInputTokens'>;

const OPENAI_FACTS: Readonly<Record<string, OpenAIFacts>> = {
  'text-embedding-3-small': { dimensions: 1536, matryoshka: [1536, 1024, 512, 256], maxInputTokens: 8191 },
  'text-embedding-3-large': { dimensions: 3072, matryoshka: [3072, 1024, 256], maxInputTokens: 8191 },
  'text-embedding-ada-002': { dimensions: 1536, matryoshka: [], maxInputTokens: 8191 },
};

/** Loads both peers and builds the SDK model once. Any import failure means the peer is not installed. */
async function loadSdk(id: string, apiKey: string, baseURL: string | undefined) {
  try {
    const [{ createOpenAI }, { embedMany, APICallError }] = await Promise.all([import('@ai-sdk/openai'), import('ai')]);
    const provider = createOpenAI(baseURL === undefined ? { apiKey } : { apiKey, baseURL });
    return { model: provider.embeddingModel(id), embedMany, apiCallError: APICallError };
  } catch {
    return ModelUnavailable({ model: id, reason: 'peer-missing' });
  }
}

/**
 * An OpenAI model record. Snapshot ids never change their vectors, so `assurance` is `immutable`.
 *
 * @example
 * const model = createOpenAIModel({ id: 'text-embedding-3-small', apiKey: process.env.OPENAI_API_KEY ?? '' });
 */
export function createOpenAIModel(options: OpenAIModelOptions) {
  const id = options.id ?? 'text-embedding-3-small';
  const facts = OPENAI_FACTS[id];
  if (facts === undefined) return ConfigurationFailure({ message: `openai model ${id} is not in the facts table` });
  if (options.apiKey === '') return ConfigurationFailure({ message: 'openai needs an apiKey' });

  let sdk: ReturnType<typeof loadSdk> | undefined;

  const embedTexts = async ({ texts, dimensions, truncate, signal }: NativeRequest) => {
    sdk ??= loadSdk(id, options.apiKey, options.baseURL);
    const loaded = await sdk;
    if (isFailure(loaded)) {
      sdk = undefined;
      return loaded;
    }
    try {
      const result = await loaded.embedMany({
        model: loaded.model,
        // OpenAI has no truncate flag: cut at the character estimate of the model's limit.
        values: truncate ? texts.map(text => text.slice(0, facts.maxInputTokens * CHARS_PER_TOKEN)) : [...texts],
        // Retries belong to withResilience, where each attempt is charged once.
        maxRetries: 0,
        ...(dimensions === undefined ? {} : { providerOptions: { openai: { dimensions } } }),
        ...(signal ? { abortSignal: signal } : {}),
      });
      const tokens = result.usage.tokens;
      return {
        vectors: result.embeddings,
        tokens: Number.isFinite(tokens)
          ? { basis: 'reported' as const, count: tokens }
          : { basis: 'unknown' as const },
      };
    } catch (error) {
      if (signal?.aborted) return Cancelled();
      if (!loaded.apiCallError.isInstance(error)) return ModelUnavailable({ model: id, reason: 'unreachable' });
      const status = error.statusCode;
      if (status === undefined) return ModelUnavailable({ model: id, reason: 'unreachable' });
      if (status === 429) {
        const wait = retryAfterMs(name => error.responseHeaders?.[name]);
        return RateLimited(wait === undefined ? {} : { retryAfterMs: wait });
      }
      if (status === 401 || status === 403) {
        return ConfigurationFailure({ message: `openai refused the API key (${status})` });
      }
      if (status === 404) return ModelUnavailable({ model: id, reason: 'unknown-model' });
      if (status === 400 && mentionsContextLength(`${error.message} ${error.responseBody ?? ''}`)) {
        return providerInputTooLong(texts, facts.maxInputTokens);
      }
      return InvalidOutput({ reason: `openai answered ${status}: ${error.message.slice(0, 200)}` });
    }
  };

  const model: EmbeddingModel = {
    provider: 'openai',
    id,
    assurance: 'immutable',
    local: false,
    ...facts,
    maxBatch: 2048,
    maxBatchTokens: 300_000,
    normalized: true,
    instruction: NO_INSTRUCTION,
    inputs: ['text'],
    quantizations: [],
    embedTexts,
  };
  return model;
}
