import { afterEach, describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';

import type { EmbeddingSpace } from './types.js';
import { ConfigurationFailure } from './failures.js';
import { resolveEmbeddingModel } from './resolve.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveEmbeddingModel', () => {
  it('explicit ref beats env order', () => {
    const model = resolveEmbeddingModel('openai:text-embedding-3-large', {
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      OPENAI_API_KEY: 'sk-test',
      EMBEDDING_MODEL: 'ollama:qwen3-embedding:0.6b',
    });
    expect(!isFailure(model) && [model.provider, model.id]).toEqual(['openai', 'text-embedding-3-large']);
    const fromVar = resolveEmbeddingModel(undefined, {
      OPENAI_API_KEY: 'sk-test',
      EMBEDDING_MODEL: 'ollama:embeddinggemma',
    });
    expect(!isFailure(fromVar) && [fromVar.provider, fromVar.id]).toEqual(['ollama', 'embeddinggemma']);
  });

  // Founder decision B1: local first, then openai, voyage, google.
  it('order is ollama then openai then voyage then google', () => {
    const all = {
      OLLAMA_BASE_URL: 'http://ollama:11434',
      OPENAI_API_KEY: 'sk-test',
      VOYAGE_API_KEY: 'pa-test',
      GOOGLE_GENERATIVE_AI_API_KEY: 'g-test',
    };
    const first = resolveEmbeddingModel(undefined, all);
    expect(!isFailure(first) && first.provider).toBe('ollama');
    const { OLLAMA_BASE_URL: _ollama, ...hosted } = all;
    const second = resolveEmbeddingModel(undefined, hosted);
    expect(!isFailure(second) && second.provider).toBe('openai');
    const { OPENAI_API_KEY: _openai, ...laterHosted } = hosted;
    const third = resolveEmbeddingModel(undefined, laterHosted);
    expect(ConfigurationFailure.is(third) && third.data.message).toContain('voyage');
    const fourth = resolveEmbeddingModel(undefined, { GOOGLE_GENERATIVE_AI_API_KEY: 'g-test' });
    expect(ConfigurationFailure.is(fourth) && fourth.data.message).toContain('google');
  });

  // A changed env under a live index must stop the app, not quietly write vectors from another space.
  it('requiredSpace mismatch is SpaceMismatch not a silent re-embed', () => {
    const stored: EmbeddingSpace = {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      normalized: true,
      quantization: 'float32',
      instructionVersion: 0,
    };
    const env = { OLLAMA_BASE_URL: 'http://127.0.0.1:11434' };
    const mismatch = resolveEmbeddingModel(undefined, env, { requiredSpace: stored });
    expect(isFailure(mismatch) && mismatch.code).toBe('embeddings.space_mismatch');
    expect(isFailure(mismatch) && mismatch.code === 'embeddings.space_mismatch' && mismatch.data.expected).toEqual(
      stored,
    );
    const same = resolveEmbeddingModel(undefined, { OPENAI_API_KEY: 'sk-test' }, { requiredSpace: stored });
    expect(isFailure(same)).toBe(false);
  });

  // A corpus stored at a Matryoshka size of the same model is the same space, not a forced re-embed.
  it('requiredSpace at a Matryoshka size of the model resolves', () => {
    const stored: EmbeddingSpace = {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 512,
      normalized: true,
      quantization: 'float32',
      instructionVersion: 0,
    };
    const model = resolveEmbeddingModel(undefined, { OPENAI_API_KEY: 'sk-test' }, { requiredSpace: stored });
    expect(!isFailure(model) && model.id).toBe('text-embedding-3-small');
    const notASize = resolveEmbeddingModel(
      undefined,
      { OPENAI_API_KEY: 'sk-test' },
      { requiredSpace: { ...stored, dimensions: 700 } },
    );
    expect(isFailure(notASize) && notASize.code).toBe('embeddings.space_mismatch');
  });

  it('nothing configured is ConfigurationFailure', () => {
    const result = resolveEmbeddingModel(undefined, {});
    expect(isFailure(result) && result.code).toBe('embeddings.configuration');
    const blank = resolveEmbeddingModel(undefined, { OPENAI_API_KEY: '  ', OLLAMA_BASE_URL: '' });
    expect(isFailure(blank) && blank.code).toBe('embeddings.configuration');
    const malformed = resolveEmbeddingModel(undefined, { EMBEDDING_MODEL: 'qwen3' });
    expect(isFailure(malformed) && malformed.code).toBe('embeddings.configuration');
  });

  // Resolution runs at boot and in request paths; it must cost nothing and never hit the network.
  it('resolve performs no fetch', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    resolveEmbeddingModel(undefined, { OLLAMA_BASE_URL: 'http://127.0.0.1:11434' });
    resolveEmbeddingModel(undefined, { OPENAI_API_KEY: 'sk-test' });
    resolveEmbeddingModel('ollama:qwen3-embedding:0.6b');
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});
