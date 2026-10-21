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
    expect(!isFailure(third) && third.provider).toBe('voyage');
    const fourth = resolveEmbeddingModel(undefined, { GOOGLE_GENERATIVE_AI_API_KEY: 'g-test' });
    expect(!isFailure(fourth) && fourth.provider).toBe('google');
  });

  // Cohere, Mistral and self-hosted servers are never picked by order (founder decision B1), only named.
  it('a named cohere, mistral or openai-compatible ref resolves from its variables', () => {
    expect(isFailure(resolveEmbeddingModel(undefined, { COHERE_API_KEY: 'co-test' }))).toBe(true);
    const cohere = resolveEmbeddingModel('cohere:embed-v4.0', { COHERE_API_KEY: 'co-test' });
    expect(!isFailure(cohere) && cohere.provider).toBe('cohere');
    const mistral = resolveEmbeddingModel(undefined, { EMBEDDING_MODEL: 'mistral:mistral-embed', MISTRAL_API_KEY: 'm-test' });
    expect(!isFailure(mistral) && mistral.provider).toBe('mistral');
    const noKey = resolveEmbeddingModel('mistral:mistral-embed', {});
    expect(ConfigurationFailure.is(noKey) && noKey.data.message).toContain('MISTRAL_API_KEY');
    const compatible = resolveEmbeddingModel('openai-compatible:Qwen/Qwen3-Embedding-8B', {
      OPENAI_COMPATIBLE_BASE_URL: 'http://tei:8080/v1',
      OPENAI_COMPATIBLE_DIMENSIONS: '4096',
    });
    expect(!isFailure(compatible) && [compatible.id, compatible.dimensions]).toEqual(['Qwen/Qwen3-Embedding-8B', 4096]);
    // The server does not say its size; a guessed one would make every vector fail validation.
    const sizeless = resolveEmbeddingModel('openai-compatible:x', { OPENAI_COMPATIBLE_BASE_URL: 'http://tei:8080/v1' });
    expect(ConfigurationFailure.is(sizeless) && sizeless.data.message).toContain('OPENAI_COMPATIBLE_DIMENSIONS');
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

  // The dtype is chosen by the embedder, so a binary index must not refuse the model that made it.
  it('requiredSpace of a quantized index resolves the same model', () => {
    const stored: EmbeddingSpace = {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      normalized: true,
      quantization: 'int8',
      calibration: '0123456789abcdef',
      instructionVersion: 0,
    };
    const model = resolveEmbeddingModel(undefined, { OPENAI_API_KEY: 'sk-test' }, { requiredSpace: stored });
    expect(!isFailure(model) && model.id).toBe('text-embedding-3-small');
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
    resolveEmbeddingModel(undefined, { VOYAGE_API_KEY: 'pa-test' });
    resolveEmbeddingModel(undefined, { GOOGLE_GENERATIVE_AI_API_KEY: 'g-test' });
    resolveEmbeddingModel('cohere:embed-v4.0', { COHERE_API_KEY: 'co-test' });
    resolveEmbeddingModel('mistral:mistral-embed', { MISTRAL_API_KEY: 'm-test' });
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});
