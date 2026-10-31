/**
 * Dot units: `vectorIndex(...)` (the app's vector index) and `llm(...)` (the app's
 * text-generation provider, checked at boot).
 *
 * `vectorIndex(...)` — the app's vector index as a Dot unit, sized by an embedding space.
 * The embedder itself comes from `embeddings()` in `@arki/embeddings/dot`.
 *
 * Resolved ONCE at boot from the thunks (no module-level cache): the index is Qdrant or the
 * in-memory mock (`createVectorIndex`), sized by `space`. With no space (no embedding provider
 * configured) the app still boots: `vectorIndex.provider` is `null`, so features degrade instead
 * of failing the boot. Tests inject `provider` and never touch env.
 */
import type { Embedder, EmbeddingSpace } from '@arki/embeddings';
import { infra } from '@arki/dot/unit';
import { isFailure } from '@arki/failure';

import type { LLMProviderConfig } from '../ai-service/factory';
import type { ProbeOptions } from '../ai-service/probe';
import type { LLMProviderWithUsage } from '../ai-service/types';
import type { VectorSearchProvider } from '../types';
import { createLLMProvider } from '../ai-service/factory';
import { probeLLMProvider } from '../ai-service/probe';
import { createVectorIndex } from '../vector-search/vector-index';

export type VectorIndexPluginOptions<P extends Record<string, unknown>> = {
  /** Collection holding every point of this app. */
  readonly collection: string;
  /** Payload fields filtered on (each gets a keyword index). */
  readonly payloadIndexes: readonly (keyof P & string)[];
  /**
   * The embedding space every point is in, or an `Embedder` whose `space` is read; `null` = no
   * embedding provider configured (the index provider is `null`). A function is called once, at boot.
   */
  readonly space:
    EmbeddingSpace | Pick<Embedder, 'space'> | null | (() => EmbeddingSpace | Pick<Embedder, 'space'> | null);
  /** Where to read `QDRANT_*` and `VECTOR_BACKEND`. Defaults to `process.env`. */
  readonly env?: () => NodeJS.ProcessEnv;
  /** Use this provider instead of building one; treated as not durable unless `durable: true`. */
  readonly provider?: VectorSearchProvider<P>;
  readonly durable?: boolean;
};

/** `process.env`, or an empty map on runtimes without `process`. */
function processEnv(): NodeJS.ProcessEnv {
  return typeof process === 'undefined' ? {} : process.env;
}

/**
 * Publish `vectorIndex`, sized by `space`. It no longer publishes `embedder`: mount `embeddings()`
 * from `@arki/embeddings/dot` for that.
 *
 * @example
 * ```ts
 * defineApp('reader').infra(
 *   vectorIndex<VectorPayload>({ collection: 'reader_embeddings', payloadIndexes: ['userId', 'kind'], space: () => embedder.space }),
 * );
 * ```
 */
export function vectorIndex<P extends Record<string, unknown>>(options: VectorIndexPluginOptions<P>) {
  const { collection, payloadIndexes, env = processEnv, provider, durable = false } = options;

  return infra({
    name: 'vectorIndex',
    provides: {
      // A bad QDRANT_* value is returned as InvalidEnvironment, which fails the boot.
      vectorIndex: (): ReturnType<typeof createVectorIndex<P>> | { provider: null; durable: false } => {
        const chosen = typeof options.space === 'function' ? options.space() : options.space;
        if (chosen === null) return { provider: null, durable: false };
        if (provider) return { provider, durable };
        const space = 'space' in chosen ? chosen.space : chosen;
        return createVectorIndex<P>(space, { collection, payloadIndexes, env: env() });
      },
    },
  });
}

export type LlmPluginOptions = LLMProviderConfig & {
  /**
   * Run `probeLLMProvider` at boot (default `true`). An unusable provider then fails boot with
   * the returned `ProviderUnavailable` failure, which `dot doctor --json` reports. Pass `false`
   * for an app that must boot without a model (it can call `probeLLMProvider` itself later).
   */
  readonly probe?: boolean;
  /** How long the boot probe waits for a server, in milliseconds. Default 2000. */
  readonly probeTimeoutMs?: number;
  /** The HTTP client the probe uses. Tests pass a stub. */
  readonly fetch?: ProbeOptions['fetch'];
  /** Publish this provider instead of building one, unprobed. Tests pass `createFakeLLMProvider(...)`. */
  readonly instance?: LLMProviderWithUsage;
};

/**
 * Publish `llm`: the app's model provider, built once at boot by `createLLMProvider`. `dot
 * explain` lists it; with `probe` (the default) boot checks the provider first, so `dot doctor`
 * reports a stopped Ollama, a missing model or a missing key as `ai.provider_unavailable`.
 *
 * Pass a function to read config at boot instead of at module load.
 *
 * @example
 * ```ts
 * defineApp('studio').infra(llm(() => ({ provider: env.LLM_PROVIDER, model: env.LLM_MODEL })));
 * // in a feature: services.llm.generateStructuredResult(prompt, schema)
 * ```
 */
export function llm(options: LlmPluginOptions | (() => LlmPluginOptions) = {}) {
  return infra({
    name: 'llm',
    provides: {
      llm: async () => {
        const config = typeof options === 'function' ? options() : options;
        if (config.instance) return config.instance;
        if (config.probe ?? true) {
          const ready = await probeLLMProvider({
            ...config,
            ...(config.probeTimeoutMs === undefined ? {} : { timeoutMs: config.probeTimeoutMs }),
          });
          if (isFailure(ready)) return ready;
        }
        return createLLMProvider(config);
      },
    },
  });
}
