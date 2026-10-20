/**
 * The expected ways an embedding call is refused, each defined once. They are returned, never
 * thrown: a caller branches on them with `isFailure` or `match`.
 */
import { z } from 'zod';

import { defineFailure, isFailure } from '@arki/failure';

import type { EmbeddingSpace, TokenCount } from './types.js';

const isObject = (value: unknown): boolean => typeof value === 'object' && value !== null;

export const RateLimited = defineFailure('embeddings.rate_limited', {
  status: 429,
  data: z.object({ retryAfterMs: z.number().optional() }),
  message: 'the embedding provider is rate limiting this caller',
  remediation: 'Wait retryAfterMs (when set) and try again, or wrap the embedder in withResilience.',
});

export const InputTooLong = defineFailure('embeddings.input_too_long', {
  status: 400,
  data: z.object({ index: z.number(), tokens: z.custom<TokenCount>(isObject), max: z.number() }),
  message: 'input {index} is longer than the model accepts ({max} tokens)',
  remediation: 'Split the text into smaller chunks before embedding it.',
});

export const ModelUnavailable = defineFailure('embeddings.model_unavailable', {
  status: 503,
  data: z.object({
    model: z.string(),
    reason: z.enum(['not-pulled', 'unreachable', 'peer-missing', 'unknown-model']),
  }),
  message: 'model {model} is unavailable ({reason})',
  remediation:
    'not-pulled: run `ollama pull <model>`; unreachable: start the server or fix the base URL; peer-missing: install the provider SDK peer.',
});

export const UnsupportedInput = defineFailure('embeddings.unsupported_input', {
  status: 400,
  data: z.object({
    /** The input at fault, or -1 when the refusal is about an option rather than one input. */
    index: z.number(),
    part: z.enum(['text', 'image', 'batch', 'dimensions', 'quantization', 'truncate']),
  }),
  message: 'the model does not support this {part} (input {index})',
});

export const InvalidOutput = defineFailure('embeddings.invalid_output', {
  status: 502,
  data: z.object({ reason: z.string() }),
  message: 'the provider answered an unusable embedding: {reason}',
});

export const SpaceMismatch = defineFailure('embeddings.space_mismatch', {
  status: 409,
  data: z.object({ expected: z.custom<EmbeddingSpace>(isObject), actual: z.custom<EmbeddingSpace>(isObject) }),
  message: 'the configured model is not the embedding space the index was built in',
  remediation: 'Re-embed the corpus in the new space, or configure the model the index was built with.',
});

export const Cancelled = defineFailure('embeddings.cancelled', {
  status: 499,
  message: 'the embedding call was cancelled',
});

export const ConfigurationFailure = defineFailure('embeddings.configuration', {
  status: 500,
  data: z.object({ message: z.string() }),
  message: 'embeddings are misconfigured: {message}',
});

export type RateLimited = ReturnType<typeof RateLimited>;
export type InputTooLong = ReturnType<typeof InputTooLong>;
export type ModelUnavailable = ReturnType<typeof ModelUnavailable>;
export type UnsupportedInput = ReturnType<typeof UnsupportedInput>;
export type InvalidOutput = ReturnType<typeof InvalidOutput>;
export type SpaceMismatch = ReturnType<typeof SpaceMismatch>;
export type Cancelled = ReturnType<typeof Cancelled>;
export type ConfigurationFailure = ReturnType<typeof ConfigurationFailure>;

const EMBED_FAILURES = [
  RateLimited,
  InputTooLong,
  ModelUnavailable,
  UnsupportedInput,
  InvalidOutput,
  SpaceMismatch,
  Cancelled,
  ConfigurationFailure,
] as const;

export type EmbedFailure = ReturnType<(typeof EMBED_FAILURES)[number]>;

/** True for a failure this package defines; false for every other value, other failures included. */
export function isEmbedFailure(value: unknown): value is EmbedFailure {
  return isFailure(value) && EMBED_FAILURES.some(definition => definition.is(value));
}
