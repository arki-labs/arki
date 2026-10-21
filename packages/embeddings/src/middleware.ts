import type { Embedder, EmbedMiddleware } from './types.js';

/**
 * The same embedder with its `embed` wrapped by each middleware, the first one outermost: it sees
 * the call first and the result last. `model` and `space` stay the wrapped embedder's own.
 *
 * @example
 * const embedder = withMiddleware(base, logCalls, countCalls); // logCalls wraps countCalls wraps base
 */
export function withMiddleware(embedder: Embedder, ...middleware: readonly EmbedMiddleware[]): Embedder {
  const embed = middleware.reduceRight<Embedder['embed']>(
    (next, wrap) => wrap(next, embedder),
    (inputs, options) => embedder.embed(inputs, options),
  );
  return {
    model: embedder.model,
    // A getter, not a copy: the space carries a revision the model learns on its first call.
    get space() {
      return embedder.space;
    },
    embed,
  };
}
