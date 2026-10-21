/**
 * `@arki/embeddings/google`: Gemini embedding models through the AI SDK.
 *
 * The SDK peers (`@ai-sdk/google`, `ai`) are loaded with a dynamic `import()` on the first call, not
 * at import, exactly like `./openai`. A missing peer is the value
 * `ModelUnavailable { reason: 'peer-missing' }`, returned by that first call.
 */
import { isFailure } from '@arki/failure';

import type { EmbeddingModel, Instruction, NativeRequest, Purpose } from '../types.js';
import { Cancelled, ConfigurationFailure, InvalidOutput, ModelUnavailable, RateLimited } from '../failures.js';
import type { FetchLike } from '../http.js';
import { mentionsContextLength, retryAfterMs } from '../http.js';
import { GEMINI_EMBEDDING_2_INSTRUCTION, NO_INSTRUCTION } from '../instructions.js';
import { providerInputTooLong, truncateByEstimate } from '../tokens.js';
import { l2Normalize } from '../vector.js';

export type GoogleModelOptions = {
  /** Default `'gemini-embedding-001'`. */
  readonly id?: string;
  readonly apiKey: string;
  /** Default: the SDK's `https://generativelanguage.googleapis.com/v1beta`. */
  readonly baseURL?: string;
  /** Replaces the global `fetch`; tests inject a stub here. */
  readonly fetch?: FetchLike;
};

type GoogleFacts = Pick<EmbeddingModel, 'dimensions' | 'matryoshka' | 'maxInputTokens'> & {
  /** `001` takes a `taskType` field. `embedding-2` does not: it takes text prefixes instead. */
  readonly taskType: boolean;
  /** `embedding-2` unit-normalises every size itself. `001` only does at 3072. */
  readonly normalizesTruncated: boolean;
  readonly instruction: Instruction;
};

// https://ai.google.dev/gemini-api/docs/embeddings (checked 2026-10-21): both models are Stable,
// output 128-3072 (default 3072), recommended sizes 768 / 1536 / 3072.
const GOOGLE_FACTS: Readonly<Record<string, GoogleFacts>> = {
  'gemini-embedding-001': {
    dimensions: 3072,
    matryoshka: [3072, 1536, 768],
    maxInputTokens: 2048,
    taskType: true,
    normalizesTruncated: false,
    instruction: NO_INSTRUCTION,
  },
  'gemini-embedding-2': {
    dimensions: 3072,
    matryoshka: [3072, 1536, 768],
    maxInputTokens: 8192,
    taskType: false,
    normalizesTruncated: true,
    // The docs' own task prefixes for this model; same strings as EmbeddingGemma's.
    instruction: GEMINI_EMBEDDING_2_INSTRUCTION,
  },
};

/** Gemini's `taskType` per purpose. */
const TASK_TYPE = {
  query: 'RETRIEVAL_QUERY',
  document: 'RETRIEVAL_DOCUMENT',
  similarity: 'SEMANTIC_SIMILARITY',
  classification: 'CLASSIFICATION',
  clustering: 'CLUSTERING',
} as const satisfies Record<Purpose, string>;

/** Loads both peers and builds the SDK model once. Any import failure means the peer is not installed. */
async function loadSdk(id: string, options: GoogleModelOptions) {
  try {
    const [{ createGoogleGenerativeAI }, { embedMany, APICallError }] = await Promise.all([
      import('@ai-sdk/google'),
      import('ai'),
    ]);
    const send = options.fetch;
    const provider = createGoogleGenerativeAI({
      apiKey: options.apiKey,
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
 * A Google Gemini model record. The ids are moving names, not dated snapshots, so `assurance` is `mutable`.
 *
 * @example
 * const model = createGoogleModel({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '' });
 */
export function createGoogleModel(options: GoogleModelOptions) {
  const id = options.id ?? 'gemini-embedding-001';
  const facts = GOOGLE_FACTS[id];
  if (facts === undefined) return ConfigurationFailure({ message: `google model ${id} is not in the facts table` });
  if (options.apiKey === '') return ConfigurationFailure({ message: 'google needs an apiKey' });

  let sdk: ReturnType<typeof loadSdk> | undefined;

  const embedTexts = async ({ texts, purpose, dimensions, truncate, signal }: NativeRequest) => {
    sdk ??= loadSdk(id, options);
    const loaded = await sdk;
    if (isFailure(loaded)) {
      sdk = undefined;
      return loaded;
    }
    const taskType = facts.taskType && purpose !== undefined ? TASK_TYPE[purpose] : undefined;
    const google = {
      ...(taskType === undefined ? {} : { taskType }),
      ...(dimensions === undefined ? {} : { outputDimensionality: dimensions }),
    };
    try {
      const result = await loaded.embedMany({
        model: loaded.model,
        // The API has no truncate flag in its docs: cut at the character estimate of the model's limit.
        values: truncate ? texts.map(text => truncateByEstimate(text, facts.maxInputTokens)) : [...texts],
        // Retries belong to withResilience, where each attempt is charged once.
        maxRetries: 0,
        ...(Object.keys(google).length === 0 ? {} : { providerOptions: { google } }),
        ...(signal ? { abortSignal: signal } : {}),
      });
      // The SDK reports no usage for Google, so the count is NaN here.
      const tokens = result.usage.tokens;
      // Google normalises only the full size (001), so a smaller one is scaled to unit length here.
      const needsNormalizing = dimensions !== undefined && dimensions !== facts.dimensions && !facts.normalizesTruncated;
      return {
        vectors: needsNormalizing ? result.embeddings.map(vector => l2Normalize(Float32Array.from(vector))) : result.embeddings,
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
        return ConfigurationFailure({ message: `google refused the API key (${status})` });
      }
      if (status === 404) return ModelUnavailable({ model: id, reason: 'unknown-model' });
      if (status === 400 && mentionsContextLength(`${error.message} ${error.responseBody ?? ''}`)) {
        return providerInputTooLong(model, texts);
      }
      return InvalidOutput({ reason: `google answered ${status}: ${error.message.slice(0, 200)}` });
    }
  };

  const model: EmbeddingModel = {
    provider: 'google',
    id,
    assurance: 'mutable',
    local: false,
    dimensions: facts.dimensions,
    matryoshka: facts.matryoshka,
    maxInputTokens: facts.maxInputTokens,
    // 100 is the SDK's per-call cap (and the batchEmbedContents cap); the token budget is that many full inputs.
    maxBatch: 100,
    maxBatchTokens: 100 * facts.maxInputTokens,
    normalized: true,
    instruction: facts.instruction,
    inputs: ['text'],
    quantizations: [],
    embedTexts,
  };
  return model;
}
