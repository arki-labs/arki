/**
 * `@arki/embeddings/mistral`: Mistral embedding models through the AI SDK.
 *
 * The SDK peers (`@ai-sdk/mistral`, `ai`) are loaded with a dynamic `import()` on the first call, not
 * at import, exactly like `./openai`. A missing peer is the value
 * `ModelUnavailable { reason: 'peer-missing' }`, returned by that first call.
 */
import { z } from 'zod';
import { isFailure } from '@arki/failure';

import type { EmbeddingModel, NativeRequest, TokenCount } from '../types.js';
import { Cancelled, ConfigurationFailure, InputTooLong, InvalidOutput, ModelUnavailable, RateLimited } from '../failures.js';
import type { FetchLike } from '../http.js';
import { functionSchema, parseOptions, withOptionsJson } from '../schemas.js';
import { retryAfterMs, requestSignal } from '../http.js';
import { NO_INSTRUCTION } from '../instructions.js';
import { countTokens, truncateByEstimate } from '../tokens.js';

// Mistral's 400 wording is undocumented, so this pattern stays loose: a miss turns InputTooLong (which a caller can
// split and retry) into an opaque InvalidOutput.
const TOO_LONG = /context length|context window|maximum context|too many tokens|input length|longer than|too long|exceeds? the (?:maximum|max|context)/i;

/** `InputTooLong` naming the input with the most tokens by `countTokens`: the likeliest culprit, with that count. */
function inputTooLong(model: EmbeddingModel, texts: readonly string[]) {
  let index = 0;
  let tokens: TokenCount = { basis: 'unknown' };
  for (const [position, text] of texts.entries()) {
    const counted = countTokens(model, text);
    if (counted.basis === 'unknown' || (tokens.basis !== 'unknown' && counted.count <= tokens.count)) continue;
    index = position;
    tokens = counted;
  }
  return InputTooLong({ index, tokens, max: model.maxInputTokens });
}

export type MistralModelOptions = {
  /** Default `'mistral-embed'`. */
  readonly id?: string;
  readonly apiKey: string;
  /** Default: the SDK's `https://api.mistral.ai/v1`. */
  readonly baseURL?: string;
  /** Replaces the global `fetch`; tests inject a stub here. */
  readonly fetch?: FetchLike;
};

/** `MistralModelOptions`, checked by `createMistralModel`; a type test locks it to the type. */
export const mistralModelOptionsSchema = withOptionsJson(
  z
    .object({
      id: z.string().min(1).optional(),
      apiKey: z.string().min(1),
      baseURL: z.url({ protocol: /^https?$/ }).optional(),
      fetch: functionSchema<FetchLike>().optional(),
    })
    .readonly(),
);

type MistralFacts = Pick<EmbeddingModel, 'dimensions' | 'matryoshka' | 'maxInputTokens'>;

// https://docs.mistral.ai/studio/knowledge-rag/embeddings/text_embeddings: 1024 dims. The 8k context
// is from the model card https://docs.mistral.ai/models/model-cards/mistral-embed-23-12.
// `codestral-embed` is left out: its dtype and size options come back through a float-only pipeline
// and its docs disagree with themselves on the vector length.
const MISTRAL_FACTS: Readonly<Record<string, MistralFacts>> = {
  'mistral-embed': { dimensions: 1024, matryoshka: [], maxInputTokens: 8192 },
};

/** Loads both peers and builds the SDK model once. Any import failure means the peer is not installed. */
async function loadSdk(id: string, options: MistralModelOptions) {
  try {
    const [{ createMistral }, { embedMany, APICallError }] = await Promise.all([import('@ai-sdk/mistral'), import('ai')]);
    const send = options.fetch;
    const provider = createMistral({
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
 * A Mistral model record. `mistral-embed` is a moving name (the dated `mistral-embed-2312` is a
 * different id), so `assurance` is `mutable`. `purpose` is ignored: the API has no such field.
 *
 * @example
 * const model = createMistralModel({ apiKey: process.env.MISTRAL_API_KEY ?? '' });
 */
export function createMistralModel(input: MistralModelOptions) {
  const options = parseOptions(mistralModelOptionsSchema, input, 'mistral');
  if (isFailure(options)) return options;
  const id = options.id ?? 'mistral-embed';
  const facts = MISTRAL_FACTS[id];
  if (facts === undefined) return ConfigurationFailure({ message: `mistral model ${id} is not in the facts table` });

  let sdk: ReturnType<typeof loadSdk> | undefined;

  const embedTexts = async ({ texts, truncate, signal }: NativeRequest) => {
    sdk ??= loadSdk(id, options);
    const loaded = await sdk;
    if (isFailure(loaded)) {
      sdk = undefined;
      return loaded;
    }
    try {
      const result = await loaded.embedMany({
        model: loaded.model,
        // The API has no truncate flag: cut at the character estimate of the model's limit.
        values: truncate ? texts.map(text => truncateByEstimate(text, facts.maxInputTokens)) : [...texts],
        // Retries belong to withResilience, where each attempt is charged once.
        maxRetries: 0,
        abortSignal: requestSignal(signal),
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
        return ConfigurationFailure({ message: `mistral refused the API key (${status})` });
      }
      if (status === 404) return ModelUnavailable({ model: id, reason: 'unknown-model' });
      if (status === 400 && TOO_LONG.test(`${error.message} ${error.responseBody ?? ''}`)) {
        return inputTooLong(model, texts);
      }
      // A server fault is worth another try: it is the same unreachable failure a dropped connection is.
      if (status >= 500) return ModelUnavailable({ model: id, reason: 'unreachable' });
      return InvalidOutput({ reason: `mistral answered ${status}: ${error.message.slice(0, 200)}` });
    }
  };

  const model: EmbeddingModel = {
    provider: 'mistral',
    id,
    assurance: 'mutable',
    local: false,
    ...facts,
    // 32 is the SDK's per-call cap; the docs state no batch limit.
    maxBatch: 32,
    maxBatchTokens: 32 * facts.maxInputTokens,
    normalized: true,
    instruction: NO_INSTRUCTION,
    inputs: ['text'],
    quantizations: [],
    embedTexts,
  };
  return model;
}
