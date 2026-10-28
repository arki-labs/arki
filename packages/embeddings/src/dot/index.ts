/**
 * `@arki/embeddings/dot`: the app's one embedder as a Dot unit. `@arki/dot` is an optional peer;
 * importing this entry without it fails at module load, on purpose.
 */
import { z } from 'zod';

import type { Policy, RetryFailure } from '@arki/resilience';
import { infra } from '@arki/dot/unit';
import { isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { EmbedFailure } from '../failures.js';
import type { CacheStore, Embedder, EmbeddingModel } from '../types.js';
import { memoryCacheStore, withCache } from '../cache.js';
import { createEmbedder } from '../embedder.js';
import { isEmbedFailure } from '../failures.js';
import { withResilience } from '../resilience.js';
import { functionSchema, objectSchema, parseOptions, withOptionsJson } from '../schemas.js';

/** Options `embeddings()` takes. Everything is read once, at boot. */
export type EmbeddingsPluginOptions = {
  /**
   * A model record, an `Embedder`, or a function returning one of them or a failure. The function
   * runs once, at boot: read the app's env there and build the model with its provider's
   * `createXModel` (a `ConfigurationFailure` for a missing key turns embeddings off, not the app).
   */
  readonly model: EmbeddingModel | Embedder | (() => EmbeddingModel | Embedder | EmbedFailure);
  /** `true`: `withCache` over a `memoryCacheStore()`; a store: `withCache` over it. Default `false`. */
  readonly cache?: boolean | CacheStore;
  /** `true`: `withResilience` with its default policy; a policy: that one. Default `false`. */
  readonly resilience?: boolean | Policy<never, RetryFailure>;
};

/** `EmbeddingsPluginOptions`, checked when `embeddings()` boots; a type test locks it to the type. */
export const embeddingsPluginOptionsSchema = withOptionsJson(
  z
    .object({
      model: z.union([
        objectSchema<EmbeddingModel | Embedder>(),
        functionSchema<() => EmbeddingModel | Embedder | EmbedFailure>(),
      ]),
      cache: z.union([z.boolean(), objectSchema<CacheStore>()]).optional(),
      resilience: z.union([z.boolean(), objectSchema<Policy<never, RetryFailure>>()]).optional(),
    })
    .readonly(),
);

function baseEmbedder(options: EmbeddingsPluginOptions): Embedder | EmbedFailure {
  const chosen = typeof options.model === 'function' ? options.model() : options.model;
  if (isEmbedFailure(chosen)) return chosen;
  return 'embed' in chosen ? chosen : createEmbedder(chosen);
}

/** The base embedder with resilience inside and the cache outside, so a hit never waits on a retry. */
function build(input: EmbeddingsPluginOptions): Embedder | EmbedFailure {
  // A bad option is a configuration that does not build: the app boots with `embedder` null (see `embeddings`).
  const options = parseOptions(embeddingsPluginOptionsSchema, input, 'embeddings plugin');
  if (isFailure(options)) return options;
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
 * build (a missing key, a size the model refuses) is logged once at `warn` and
 * `embedder` is `null`, so the app boots and features that embed degrade instead of failing it.
 *
 * @example
 * const embedding = embeddings({
 *   model: () => createOllamaModel({ id: 'qwen3-embedding:0.6b', baseURL: process.env['OLLAMA_BASE_URL'] }),
 *   cache: true,
 * });
 * defineApp('reader').infra(embedding);
 * // in a feature: needs: { embedder: embedding.provides.embedder } → Embedder | null
 */
export function embeddings(options: EmbeddingsPluginOptions) {
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
