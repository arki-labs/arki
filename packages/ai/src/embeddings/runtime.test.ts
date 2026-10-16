/**
 * Embedding runtime: one env reader for every app (local-first), and the
 * provider is built from the SAME env the selection read. The contracts:
 * explicit `EMBEDDING_PROVIDER` wins; Ollama before OpenAI; nothing
 * configured → `null` (never a silent mock); `OLLAMA_HOST` both selects Ollama
 * AND reaches the provider; the Qwen query prefix keys on the model name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildQueryText,
  createEmbedder,
  createEmbeddingRuntime,
  QWEN_QUERY_INSTRUCTION,
  resolveEmbeddingSelection,
} from './runtime';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveEmbeddingSelection', () => {
  it('returns null when nothing is configured', () => {
    expect(resolveEmbeddingSelection({})).toBeNull();
  });

  it('picks Ollama before OpenAI when both are signalled (local-first)', () => {
    expect(resolveEmbeddingSelection({ OLLAMA_BASE_URL: 'http://x:11434', OPENAI_API_KEY: 'k' })).toEqual({
      type: 'ollama',
      model: 'qwen3-embedding:0.6b',
      dimensions: 1024,
    });
  });

  it('OLLAMA_HOST alone selects Ollama', () => {
    expect(resolveEmbeddingSelection({ OLLAMA_HOST: 'http://x:11434' })?.type).toBe('ollama');
  });

  it('falls through to OpenAI on OPENAI_API_KEY', () => {
    expect(resolveEmbeddingSelection({ OPENAI_API_KEY: 'k' })).toEqual({
      type: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
  });

  it('an explicit EMBEDDING_PROVIDER wins over auto-detect', () => {
    expect(resolveEmbeddingSelection({ EMBEDDING_PROVIDER: 'openai', OLLAMA_BASE_URL: 'http://x' })?.type).toBe(
      'openai',
    );
  });

  it('mock only when named, matching the Ollama dimension', () => {
    expect(resolveEmbeddingSelection({ EMBEDDING_PROVIDER: 'mock' })).toEqual({
      type: 'mock',
      model: 'mock-embedding',
      dimensions: 1024,
    });
  });

  it('covers every provider type with its own default model and dimensions', () => {
    const table = {
      cohere: ['embed-v4.0', 1536],
      mistral: ['mistral-embed', 1024],
      google: ['gemini-embedding-001', 3072],
      bedrock: ['amazon.titan-embed-text-v2:0', 1024],
      voyage: ['voyage-3.5', 1024],
      jina: ['jina-embeddings-v3', 1024],
      nebius: ['Qwen/Qwen3-Embedding-8B', 4096],
      mixedbread: ['mixedbread-ai/mxbai-embed-large-v1', 1024],
      'transformers-js': ['nomic-ai/nomic-embed-text-v1.5', 768],
    } as const;
    for (const [type, [model, dimensions]] of Object.entries(table)) {
      expect(resolveEmbeddingSelection({ EMBEDDING_PROVIDER: type })).toEqual({ type, model, dimensions });
    }
  });

  it('reads the per-provider model var and the EMBEDDING_DIMENSIONS override', () => {
    expect(
      resolveEmbeddingSelection({
        OLLAMA_HOST: 'h',
        OLLAMA_EMBEDDING_MODEL: 'qwen3-embedding:4b',
        EMBEDDING_DIMENSIONS: '2560',
      }),
    ).toEqual({ type: 'ollama', model: 'qwen3-embedding:4b', dimensions: 2560 });
    expect(
      resolveEmbeddingSelection({ EMBEDDING_PROVIDER: 'nebius', NEBIUS_EMBEDDING_DIMENSIONS: '1024' })?.dimensions,
    ).toBe(1024);
  });

  it('openai-compatible needs its model and dimensions', () => {
    expect(() => resolveEmbeddingSelection({ EMBEDDING_PROVIDER: 'openai-compatible' })).toThrow(/OPENAI_COMPATIBLE/);
    expect(
      resolveEmbeddingSelection({
        EMBEDDING_PROVIDER: 'openai-compatible',
        OPENAI_COMPATIBLE_MODEL: 'BAAI/bge-m3',
        OPENAI_COMPATIBLE_DIMENSIONS: '1024',
      }),
    ).toEqual({ type: 'openai-compatible', model: 'BAAI/bge-m3', dimensions: 1024 });
  });

  it('throws on an unknown explicit type', () => {
    expect(() => resolveEmbeddingSelection({ EMBEDDING_PROVIDER: 'pinecone' })).toThrow(
      /Unsupported EMBEDDING_PROVIDER/,
    );
  });
});

describe('createEmbeddingRuntime', () => {
  it('is null when unconfigured', async () => {
    await expect(createEmbeddingRuntime({})).resolves.toBeNull();
  });

  it('OLLAMA_HOST reaches the provider, not only the selection', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(Response.json({ embeddings: [[0, 1]] }));
    });
    const runtime = await createEmbeddingRuntime({ OLLAMA_HOST: 'http://ollama.lan:11434' });
    expect(runtime?.selection.type).toBe('ollama');
    await runtime?.provider.getEmbeddings(['x']);
    expect(urls[0]).toBe('http://ollama.lan:11434/api/embed');
  });

  it('builds the mock provider at the selected dimension', async () => {
    const runtime = await createEmbeddingRuntime({ EMBEDDING_PROVIDER: 'mock', EMBEDDING_DIMENSIONS: '8' });
    expect(runtime?.provider.getDimensions?.()).toBe(8);
    const vector = await runtime?.provider.getEmbedding('a');
    expect(vector).toHaveLength(8);
  });
});

describe('buildQueryText', () => {
  it('prefixes the Qwen instruction by model name, whatever the provider type', () => {
    const nebius = { type: 'nebius', model: 'Qwen/Qwen3-Embedding-8B', dimensions: 4096 } as const;
    const ollama = { type: 'ollama', model: 'qwen3-embedding:0.6b', dimensions: 1024 } as const;
    const openai = { type: 'openai', model: 'text-embedding-3-small', dimensions: 1536 } as const;
    expect(buildQueryText('q', nebius)).toBe(`${QWEN_QUERY_INSTRUCTION}q`);
    expect(buildQueryText('q', ollama)).toBe(`${QWEN_QUERY_INSTRUCTION}q`);
    expect(buildQueryText('q', openai)).toBe('q');
  });
});

async function mockRuntime(env: Record<string, string>) {
  const runtime = await createEmbeddingRuntime(env);
  if (!runtime) throw new Error('mock runtime expected');
  return runtime;
}

describe('createEmbedder', () => {
  it('returns null without a runtime', async () => {
    await expect(createEmbedder(null).embedQuery('q')).resolves.toBeNull();
  });

  it('guards the expected dimension and remembers the observed one', async () => {
    const runtime = await mockRuntime({ EMBEDDING_PROVIDER: 'mock', EMBEDDING_DIMENSIONS: '4' });
    const embedder = createEmbedder(runtime);
    const embedding = await embedder.embedQuery('q', 4);
    expect(embedding?.vector).toHaveLength(4);
    expect(embedding?.selection.model).toBe('mock-embedding');
    // Known mismatch: skipped without an embedding call.
    const getEmbedding = vi.spyOn(runtime.provider, 'getEmbedding');
    await expect(embedder.embedQuery('q', 8)).resolves.toBeNull();
    expect(getEmbedding).not.toHaveBeenCalled();
  });

  it('turns a provider failure into null, never a throw on the hot path', async () => {
    const runtime = await mockRuntime({ EMBEDDING_PROVIDER: 'mock' });
    vi.spyOn(runtime.provider, 'getEmbedding').mockRejectedValue(new Error('down'));
    await expect(createEmbedder(runtime).embedQuery('q')).resolves.toBeNull();
  });
});
