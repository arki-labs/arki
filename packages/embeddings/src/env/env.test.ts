import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { resolveEmbeddingModel } from '../resolve.js';
import { resolveEmbeddingConfig } from './index.js';

describe('./env resolveEmbeddingConfig', () => {
  // The validated record feeds resolveEmbeddingModel directly, so the two can never disagree on names.
  it('returns a plain record resolveEmbeddingModel accepts', () => {
    const config = resolveEmbeddingConfig({ EMBEDDING_MODEL: 'openai:text-embedding-3-small', OPENAI_API_KEY: 'sk-test' });
    if (isFailure(config)) throw new Error(config.message);
    expect(config.EMBEDDING_MODEL).toBe('openai:text-embedding-3-small');
    const model = resolveEmbeddingModel(undefined, config);
    expect(!isFailure(model) && model.provider).toBe('openai');
  });

  // A typo in a deploy's env must be a value naming the variable, not a crash at first read.
  it('a malformed variable is ConfigurationFailure naming it', () => {
    const bad = resolveEmbeddingConfig({ EMBEDDING_MODEL: 'qwen3', OLLAMA_BASE_URL: 'not a url' });
    expect(isFailure(bad) && bad.code).toBe('embeddings.configuration');
    expect(isFailure(bad) && bad.data.message).toContain('OLLAMA_BASE_URL');
  });
});
