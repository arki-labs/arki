import { z } from 'zod';

import { isFailure } from '@arki/failure';

import type { Embedder, EmbeddingModelRef, EmbeddingProviderName, EmbeddingSpace, EnvSource } from './types.js';
import { Cancelled, ConfigurationFailure, SpaceMismatch } from './failures.js';
import { createCohereModel } from './cohere/index.js';
import { createGoogleModel } from './google/index.js';
import { createMistralModel } from './mistral/index.js';
import { createOllamaModel } from './ollama/index.js';
import { createOpenAICompatibleModel } from './openai-compatible/index.js';
import { createOpenAIModel } from './openai/index.js';
import { createVoyageModel } from './voyage/index.js';
import { parseModelRef } from './ref.js';
import { isSameSpace, spaceOf } from './space.js';

/** A variable counts as set when it holds something other than whitespace (Docker bakes unset vars as `""`). */
function read(env: EnvSource, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** The key each hosted provider reads. */
const KEYS = {
  voyage: 'VOYAGE_API_KEY',
  cohere: 'COHERE_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
} as const;

/** Founder decision B1: local first, then hosted `openai → voyage → google`. Nothing set chooses nothing. */
function chooseProvider(env: EnvSource): EmbeddingProviderName | undefined {
  if (read(env, 'OLLAMA_BASE_URL') !== undefined) return 'ollama';
  if (read(env, 'OPENAI_API_KEY') !== undefined) return 'openai';
  if (read(env, KEYS.voyage) !== undefined) return 'voyage';
  if (read(env, KEYS.google) !== undefined) return 'google';
  return undefined;
}

/** A size from an env string: the server will not say what it serves, so the operator must. */
const SIZE = z.coerce.number().int().positive();

function buildModel(provider: EmbeddingProviderName, id: string | undefined, env: EnvSource) {
  if (provider === 'ollama') {
    const baseURL = read(env, 'OLLAMA_BASE_URL');
    return createOllamaModel({ ...(id === undefined ? {} : { id }), ...(baseURL === undefined ? {} : { baseURL }) });
  }
  if (provider === 'openai') {
    const apiKey = read(env, 'OPENAI_API_KEY');
    if (apiKey === undefined) return ConfigurationFailure({ message: 'openai needs OPENAI_API_KEY' });
    const baseURL = read(env, 'OPENAI_BASE_URL');
    return createOpenAIModel({
      apiKey,
      ...(id === undefined ? {} : { id }),
      ...(baseURL === undefined ? {} : { baseURL }),
    });
  }
  if (provider === 'voyage' || provider === 'cohere' || provider === 'google' || provider === 'mistral') {
    const name = KEYS[provider];
    const apiKey = read(env, name);
    if (apiKey === undefined) return ConfigurationFailure({ message: `${provider} needs ${name}` });
    const options = { apiKey, ...(id === undefined ? {} : { id }) };
    if (provider === 'voyage') return createVoyageModel(options);
    if (provider === 'cohere') return createCohereModel(options);
    if (provider === 'google') return createGoogleModel(options);
    return createMistralModel(options);
  }
  if (provider === 'openai-compatible') {
    const baseURL = read(env, 'OPENAI_COMPATIBLE_BASE_URL');
    const dimensions = SIZE.safeParse(read(env, 'OPENAI_COMPATIBLE_DIMENSIONS'));
    if (id === undefined || baseURL === undefined || !dimensions.success) {
      return ConfigurationFailure({
        message:
          'openai-compatible needs a ref with the model (openai-compatible:<id>), OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_DIMENSIONS (a positive integer)',
      });
    }
    const apiKey = read(env, 'OPENAI_COMPATIBLE_API_KEY');
    return createOpenAICompatibleModel({ id, baseURL, dimensions: dimensions.data, ...(apiKey === undefined ? {} : { apiKey }) });
  }
  if (provider === 'fake') {
    return ConfigurationFailure({ message: 'the fake model is built with fakeEmbedder from @arki/embeddings/testing' });
  }
  return ConfigurationFailure({ message: `provider ${provider} is not available yet` });
}

/**
 * Picks the embedding model from an explicit ref, else `EMBEDDING_MODEL`, else the first configured
 * provider in the order `ollama → openai → voyage → google`. Pure: no network, no `process.env`
 * (pass it). With `requiredSpace`, a model whose space differs is `SpaceMismatch`, never a silent re-embed.
 *
 * @example
 * const model = resolveEmbeddingModel(undefined, process.env, { requiredSpace: storedSpace });
 */
export function resolveEmbeddingModel(
  ref?: EmbeddingModelRef,
  env: EnvSource = {},
  options: { readonly requiredSpace?: EmbeddingSpace } = {},
) {
  const named = ref ?? read(env, 'EMBEDDING_MODEL');
  const parsed = named === undefined ? undefined : parseModelRef(named);
  if (parsed !== undefined && isFailure(parsed)) return parsed;
  const provider = parsed?.provider ?? chooseProvider(env);
  if (provider === undefined) {
    return ConfigurationFailure({
      message:
        'no embedding provider is configured; set EMBEDDING_MODEL, OLLAMA_BASE_URL (http://127.0.0.1:11434 for a local Ollama) or a provider API key',
    });
  }
  const model = buildModel(provider, parsed?.id, env);
  if (isFailure(model)) return model;

  const required = options.requiredSpace;
  if (required !== undefined) {
    // A required size the model can shrink to (Matryoshka) is that model's space at that size. The
    // dtype is the embedder's choice, not the model's, so the required one is taken as given.
    const dimensions = model.matryoshka.includes(required.dimensions) ? required.dimensions : model.dimensions;
    const actual = spaceOf(model, dimensions, required.quantization, required.calibration);
    if (!isSameSpace(required, actual)) return SpaceMismatch({ expected: required, actual });
  }
  return model;
}

/**
 * The embedder's space with its revision known, to compare with a stored space id before anything
 * is embedded. Ollama reads its model digest (one metadata request, no embedding); other models
 * answer at once. A digest it cannot read is `ModelUnavailable` (`unreachable` or `not-pulled`).
 *
 * @example
 * const space = await resolveSpace(embedder);
 * if (!isFailure(space)) await db.select().from(rows).where(ne(rows.spaceId, spaceId(space)));
 */
export async function resolveSpace(embedder: Embedder, options: { readonly signal?: AbortSignal } = {}) {
  if (options.signal?.aborted) return Cancelled();
  const missing = await embedder.model.loadRevision?.(options.signal);
  if (options.signal?.aborted) return Cancelled();
  if (missing !== undefined) return missing;
  return embedder.space;
}
