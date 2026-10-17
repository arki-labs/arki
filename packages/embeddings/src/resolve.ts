import { isFailure } from '@arki/failure';

import type { EmbeddingModelRef, EmbeddingProviderName, EmbeddingSpace, EnvSource } from './types.js';
import { ConfigurationFailure, SpaceMismatch } from './failures.js';
import { createOllamaModel } from './ollama/index.js';
import { createOpenAIModel } from './openai/index.js';
import { parseModelRef } from './ref.js';
import { isSameSpace, spaceOf } from './space.js';

/** A variable counts as set when it holds something other than whitespace (Docker bakes unset vars as `""`). */
function read(env: EnvSource, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** Founder decision B1: local first, then hosted `openai → voyage → google`. Nothing set chooses nothing. */
function chooseProvider(env: EnvSource): EmbeddingProviderName | undefined {
  if (read(env, 'OLLAMA_BASE_URL') !== undefined) return 'ollama';
  if (read(env, 'OPENAI_API_KEY') !== undefined) return 'openai';
  if (read(env, 'VOYAGE_API_KEY') !== undefined) return 'voyage';
  if (read(env, 'GOOGLE_GENERATIVE_AI_API_KEY') !== undefined) return 'google';
  return undefined;
}

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
  if (provider === 'voyage' || provider === 'google') {
    return ConfigurationFailure({ message: `provider ${provider} arrives in slice 5` });
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
    // A required size the model can shrink to (Matryoshka) is that model's space at that size.
    const dimensions = model.matryoshka.includes(required.dimensions) ? required.dimensions : model.dimensions;
    const actual = spaceOf(model, dimensions, 'float32');
    if (!isSameSpace(required, actual)) return SpaceMismatch({ expected: required, actual });
  }
  return model;
}
