/**
 * `vectorIndex(...)` — the app's embedder and vector index as a Dot plugin.
 *
 * Resolved ONCE at boot from the env thunk (no module-level cache): the
 * embedding runtime is read local-first (`createEmbeddingRuntime`), the index
 * is Qdrant or the in-memory mock (`createVectorIndex`), sized by the
 * runtime's embedding space. With no provider
 * configured the app still boots: `vectorIndex.provider` is `null` and
 * `embedder.embedQuery` answers `null`, so features degrade instead of
 * failing the boot. Tests inject `runtime` and/or `provider` and never
 * touch env.
 */
import type { EmbeddingProviderName, EmbeddingSpace } from '@arki/embeddings';
import { plugin } from '@arki/dot/plugin';

import type { EmbeddingProviderType } from '../embeddings/factory';
import type { EmbeddingRuntime, EnvSource } from '../embeddings/runtime';
import type { VectorSearchProvider } from '../types';
import type { VectorIndex } from '../vector-search/vector-index';
import { createEmbedder, createEmbeddingRuntime } from '../embeddings/runtime';
import { createVectorIndex } from '../vector-search/vector-index';

export type VectorIndexPluginOptions<P extends Record<string, unknown>> = {
  /** Collection holding every point of this app. */
  readonly collection: string;
  /** Payload fields filtered on (each gets a keyword index). */
  readonly payloadIndexes: readonly (keyof P & string)[];
  /** Where to read `EMBEDDING_PROVIDER`, `OLLAMA_*`, `QDRANT_*`, … Defaults to `process.env`. */
  readonly env?: () => EnvSource;
  /** Use this runtime instead of reading env (`null` = no provider configured). */
  readonly runtime?: EmbeddingRuntime | null;
  /** Use this provider instead of building one; treated as not durable unless `durable: true`. */
  readonly provider?: VectorSearchProvider<P>;
  readonly durable?: boolean;
};

/**
 * Bridge until slice 2 moves this plugin onto `@arki/embeddings`: the old runtime's provider
 * type named as an embedding-space provider. Nebius and Mixedbread are hosted APIs with no
 * own adapter, so they count as `openai-compatible`.
 */
const SPACE_PROVIDER = {
  openai: 'openai',
  'openai-compatible': 'openai-compatible',
  cohere: 'cohere',
  mistral: 'mistral',
  google: 'google',
  bedrock: 'bedrock',
  ollama: 'ollama',
  voyage: 'voyage',
  jina: 'jina',
  nebius: 'openai-compatible',
  mixedbread: 'openai-compatible',
  'transformers-js': 'transformers',
  mock: 'fake',
} as const satisfies Record<EmbeddingProviderType, EmbeddingProviderName>;

/**
 * The space the old runtime embeds into. It neither normalises its vectors nor versions its
 * Qwen query prefix, so the space says `raw` and instruction version 0.
 */
function runtimeSpace({ selection }: EmbeddingRuntime): EmbeddingSpace {
  return {
    provider: SPACE_PROVIDER[selection.type],
    model: selection.model,
    dimensions: selection.dimensions,
    normalized: false,
    quantization: 'float32',
    instructionVersion: 0,
  };
}

/** `process.env`, or an empty map on runtimes without `process`. */
function processEnv(): EnvSource {
  return typeof process === 'undefined' ? {} : process.env;
}

/**
 * Publish `embedder` and `vectorIndex`.
 *
 * @example
 * ```ts
 * defineApp('reader').use(vectorIndex<VectorPayload>({ collection: 'reader_embeddings', payloadIndexes: ['userId', 'kind'] }));
 * ```
 */
export function vectorIndex<P extends Record<string, unknown>>(options: VectorIndexPluginOptions<P>) {
  const { collection, payloadIndexes, env = processEnv, provider, durable = false } = options;

  let resolved: Promise<{ runtime: EmbeddingRuntime | null; source: EnvSource }> | undefined;
  const resolve = () =>
    (resolved ??= (async () => {
      const source = env();
      const runtime = options.runtime === undefined ? await createEmbeddingRuntime(source) : options.runtime;
      return { runtime, source };
    })());

  return plugin({
    name: 'vectorIndex',
    provides: {
      embedder: async () => {
        const { runtime } = await resolve();
        return createEmbedder(runtime);
      },
      vectorIndex: async (): Promise<VectorIndex<P> | { provider: null; durable: false }> => {
        const { runtime, source } = await resolve();
        if (!runtime) return { provider: null, durable: false };
        if (provider) return { provider, durable };
        return createVectorIndex<P>(runtimeSpace(runtime), { collection, payloadIndexes, env: source });
      },
    },
  });
}
