import { isFailure } from '@arki/failure';

import type { EmbeddingModelRef, EmbeddingProviderName } from './types.js';
import { ConfigurationFailure } from './failures.js';
import { EMBEDDING_PROVIDERS } from './types.js';

const PROVIDERS = new Set<string>(EMBEDDING_PROVIDERS);

const isProviderName = (value: string): value is EmbeddingProviderName => PROVIDERS.has(value);

/** Splits `'ollama:qwen3-embedding:0.6b'` at the first `:`. The provider must be known and the id non-empty. */
export function parseModelRef(ref: string) {
  const colon = ref.indexOf(':');
  const provider = colon === -1 ? ref : ref.slice(0, colon);
  const id = colon === -1 ? '' : ref.slice(colon + 1);
  if (!isProviderName(provider) || id === '') {
    return ConfigurationFailure({ message: `${JSON.stringify(ref)} is not a provider:model reference` });
  }
  return { provider, id };
}

/** True for a well-formed `EmbeddingModelRef`. */
export function isModelRef(value: unknown): value is EmbeddingModelRef {
  return typeof value === 'string' && !isFailure(parseModelRef(value));
}
