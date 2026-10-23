/**
 * `@arki/embeddings/google`: Gemini embedding models. Text goes through the AI SDK; a call with an
 * image goes straight to the REST `batchEmbedContents` endpoint with `fetch`, because the SDK's
 * `embedMany` takes strings only.
 *
 * The SDK peers (`@ai-sdk/google`, `ai`) are loaded with a dynamic `import()` on the first call, not
 * at import, exactly like `./openai`. A missing peer is the value
 * `ModelUnavailable { reason: 'peer-missing' }`, returned by that first call.
 */
import { isFailure } from '@arki/failure';
import { is } from '@arki/schema';
import { z } from 'zod';

import type { EmbeddingModel, Instruction, NativeInput, NativeInputsRequest, NativeRequest, Purpose, TokenCount } from '../types.js';
import { Cancelled, ConfigurationFailure, InputTooLong, InvalidOutput, ModelUnavailable, RateLimited } from '../failures.js';
import type { FetchLike } from '../http.js';
import { retryAfterMs } from '../http.js';
import { GEMINI_EMBEDDING_2_INSTRUCTION, NO_INSTRUCTION } from '../instructions.js';
import { countTokens, truncateByEstimate } from '../tokens.js';
import { l2Normalize } from '../vector.js';
import { toBase64 } from '../base64.js';

// Gemini's wording as seen in API errors ("exceeds the maximum number of tokens", "input token count ... exceeds"). Not in the API reference.
const TOO_LONG = /exceeds the maximum number of tokens|input token count/i;

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
  /** Takes image parts. Only `embedding-2` does. */
  readonly images: boolean;
};

// https://ai.google.dev/gemini-api/docs/embeddings (checked 2026-10-21, images re-read 2026-10-22): both
// models are Stable, output 128-3072 (default 3072), recommended sizes 768 / 1536 / 3072. Only
// `gemini-embedding-2` is multimodal ("the first multimodal embedding model in the Gemini API"); `001` is text only.
const GOOGLE_FACTS: Readonly<Record<string, GoogleFacts>> = {
  'gemini-embedding-001': {
    dimensions: 3072,
    matryoshka: [3072, 1536, 768],
    maxInputTokens: 2048,
    taskType: true,
    normalizesTruncated: false,
    instruction: NO_INSTRUCTION,
    images: false,
  },
  'gemini-embedding-2': {
    dimensions: 3072,
    matryoshka: [3072, 1536, 768],
    maxInputTokens: 8192,
    taskType: false,
    normalizesTruncated: true,
    // The docs' own task prefixes for this model; same strings as EmbeddingGemma's.
    instruction: GEMINI_EMBEDDING_2_INSTRUCTION,
    images: true,
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

/** `batchEmbedContents` answer: one `{ values }` per request, in request order. */
const batchResponseSchema = z.object({ embeddings: z.array(z.object({ values: z.array(z.number()) })) });

/**
 * One input as Gemini `parts`: its text, then its image as `inlineData`. Parts of one `content`
 * become ONE embedding (docs, 2026-10-22), so a text+image input stays one vector.
 */
function partsOf(input: NativeInput) {
  const parts: ({ readonly text: string } | { readonly inlineData: { readonly mimeType: string; readonly data: string } })[] = [];
  if (input.text !== undefined) parts.push({ text: input.text });
  if (input.image !== undefined) parts.push({ inlineData: { mimeType: input.mimeType, data: toBase64(input.image) } });
  return parts;
}

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
      if (status === 400 && TOO_LONG.test(`${error.message} ${error.responseBody ?? ''}`)) {
        return inputTooLong(model, texts);
      }
      return InvalidOutput({ reason: `google answered ${status}: ${error.message.slice(0, 200)}` });
    }
  };

  const baseURL = (options.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const send: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));

  /**
   * Text and images in one `batchEmbedContents` call: one request per input, so the answer holds one
   * vector per input in input order. No `taskType` (embedding-2 rejects it); the purpose is in the text prefix.
   */
  const embedInputs = async ({ inputs, dimensions, truncate, signal }: NativeInputsRequest) => {
    const texts = inputs.map(input => input.text ?? '');
    let response: Response;
    try {
      response = await send(`${baseURL}/models/${id}:batchEmbedContents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
        body: JSON.stringify({
          requests: inputs.map(input => ({
            model: `models/${id}`,
            content: {
              parts: partsOf(
                truncate && input.text !== undefined ? { ...input, text: truncateByEstimate(input.text, facts.maxInputTokens) } : input,
              ),
            },
            ...(dimensions === undefined ? {} : { outputDimensionality: dimensions }),
          })),
        }),
        ...(signal ? { signal } : {}),
      });
    } catch {
      return signal?.aborted ? Cancelled() : ModelUnavailable({ model: id, reason: 'unreachable' });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 429) {
        const wait = retryAfterMs(name => response.headers.get(name));
        return RateLimited(wait === undefined ? {} : { retryAfterMs: wait });
      }
      if (response.status === 401 || response.status === 403) {
        return ConfigurationFailure({ message: `google refused the API key (${response.status})` });
      }
      if (response.status === 404) return ModelUnavailable({ model: id, reason: 'unknown-model' });
      if (response.status === 400 && TOO_LONG.test(text)) return inputTooLong(model, texts);
      return InvalidOutput({ reason: `google answered ${response.status}: ${text.slice(0, 200)}` });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return signal?.aborted ? Cancelled() : InvalidOutput({ reason: 'google answered malformed JSON' });
    }
    if (!is(body, batchResponseSchema)) return InvalidOutput({ reason: 'google answered without embeddings[].values' });
    if (body.embeddings.length !== inputs.length) {
      return InvalidOutput({ reason: `google: expected ${inputs.length} embeddings, got ${body.embeddings.length}` });
    }
    const needsNormalizing = dimensions !== undefined && dimensions !== facts.dimensions && !facts.normalizesTruncated;
    const vectors = body.embeddings.map(row => (needsNormalizing ? l2Normalize(Float32Array.from(row.values)) : row.values));
    // The REST answer carries no usage, as with the SDK path.
    return { vectors, tokens: { basis: 'unknown' as const } };
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
    inputs: facts.images ? ['text', 'image'] : ['text'],
    quantizations: [],
    embedTexts,
    ...(facts.images ? { embedInputs } : {}),
  };
  return model;
}
