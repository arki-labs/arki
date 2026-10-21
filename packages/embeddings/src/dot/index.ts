/**
 * `@arki/embeddings/dot`: the app's one embedder as a Dot unit. `@arki/dot` is an optional peer;
 * importing this entry without it fails at module load, on purpose.
 */
import type { Policy, RetryWaitFailure } from '@arki/resilience';
import { infra } from '@arki/dot/unit';
import { getLogger } from '@arki/log';

import type { EmbedFailure } from '../failures.js';
import type { CacheStore, Embedder, EmbeddingModel, EmbeddingModelRef, EnvSource } from '../types.js';
import { memoryCacheStore, withCache } from '../cache.js';
import { createEmbedder } from '../embedder.js';
import { isEmbedFailure } from '../failures.js';
import { withResilience } from '../resilience.js';
import { resolveEmbeddingModel } from '../resolve.js';

/** What the plugin builds from: a ref to resolve, a model record, or an embedder an app built itself. */
type ModelChoice = EmbeddingModelRef | EmbeddingModel | Embedder;

/** Options `embeddings()` takes. Everything is read once, at boot. */
type EmbeddingsPluginOptions = {
  /**
   * A ref (`'ollama:qwen3-embedding:0.6b'`), a model record, an `Embedder`, or a function returning
   * one of the last two or a failure. Absent: `resolveEmbeddingModel` picks from `env`.
   */
  readonly model?: ModelChoice | (() => EmbeddingModel | Embedder | EmbedFailure);
  /** `true`: `withCache` over a `memoryCacheStore()`; a store: `withCache` over it. Default `false`. */
  readonly cache?: boolean | CacheStore;
  /** `true`: `withResilience` with its default policy; a policy: that one. Default `false`. */
  readonly resilience?: boolean | Policy<never, RetryWaitFailure>;
  /** Where a ref or `EMBEDDING_MODEL` is resolved from. Default `process.env`. */
  readonly env?: () => EnvSource;
};

/** `process.env`, or an empty map on runtimes without `process`. */
function processEnv(): EnvSource {
  return typeof process === 'undefined' ? {} : process.env;
}

function baseEmbedder(options: EmbeddingsPluginOptions): Embedder | EmbedFailure {
  const chosen = typeof options.model === 'function' ? options.model() : options.model;
  if (chosen === undefined || typeof chosen === 'string') {
    const model = resolveEmbeddingModel(chosen, (options.env ?? processEnv)());
    return isEmbedFailure(model) ? model : createEmbedder(model);
  }
  if (isEmbedFailure(chosen)) return chosen;
  return 'embed' in chosen ? chosen : createEmbedder(chosen);
}

/** The base embedder with resilience inside and the cache outside, so a hit never waits on a retry. */
function build(options: EmbeddingsPluginOptions): Embedder | EmbedFailure {
  const base = baseEmbedder(options);
  if (isEmbedFailure(base)) return base;
  const { cache = false, resilience = false } = options;
  const resilient =
    resilience === false ? base : resilience === true ? withResilience(base) : withResilience(base, resilience);
  if (cache === false) return resilient;
  return withCache(resilient, cache === true ? memoryCacheStore() : cache);
}

/**
 * Publish `embedder`: the app's one `Embedder`, built once at boot. A configuration that does not
 * resolve (no provider set, a bad ref, a size the model refuses) is logged once at `warn` and
 * `embedder` is `null`, so the app boots and features that embed degrade instead of failing it.
 *
 * @example
 * defineApp('reader').infra(embeddings({ model: 'ollama:qwen3-embedding:0.6b', cache: true }));
 * // in a feature: needs: { embedder: embedding.provides.embedder } → Embedder | null
 */
export function embeddings(options: EmbeddingsPluginOptions = {}) {
  return infra({
    name: 'embeddings',
    provides: {
      embedder: (): Embedder | null => {
        const built = build(options);
        if (!isEmbedFailure(built)) return built;
        getLogger('arki:embeddings').warn('embeddings are off, embedder is null: {code} {reason}', {
          code: built.code,
          reason: built.message,
        });
        return null;
      },
    },
  });
}
