import { isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { Embedder, EmbeddingsLogger, EmbedInput } from './types.js';
import { withMiddleware } from './middleware.js';

/** Options `withTelemetry` takes. */
type TelemetryOptions = {
  /** Where the `arki.embed` events go. Default: `getLogger('arki:embeddings')`. */
  readonly log?: EmbeddingsLogger;
  /**
   * Put the input texts on the event (images as `'<image>'`). Default `false`: inputs carry emails,
   * names and tokens, and a log is the wrong place for them.
   */
  readonly recordInputs?: boolean;
};

function describeInput(input: EmbedInput): string {
  if (typeof input === 'string') return input;
  return input.image === undefined ? (input.text ?? '') : '<image>';
}

/**
 * The same embedder with one `arki.embed` event per `embed` call, at `info`. `@arki/log` has no
 * span type, so the event is the span: it carries the duration and, through `@arki/log/otel`, the
 * active trace. Fields: `provider`, `model`, `dimensions`, `inputs` (the count), `tokenBasis`,
 * `tokens`, `requests`, `cacheHits`, `durationMs` and `outcome` (`'ok'` or the failure's code).
 * Input texts are left out unless `recordInputs: true`.
 *
 * Wrap it outside `withCache` to see hits, inside it to see only provider calls.
 *
 * @example
 * const embedder = withTelemetry(withCache(base)); // one event per call, cache hits counted
 */
export function withTelemetry(embedder: Embedder, options: TelemetryOptions = {}): Embedder {
  const log = options.log ?? getLogger('arki:embeddings');
  const recordInputs = options.recordInputs ?? false;
  return withMiddleware(embedder, (next, wrapped) => async (inputs, callOptions) => {
    const started = Date.now();
    const result = await next(inputs, callOptions);
    const space = isFailure(result) ? wrapped.space : result.space;
    const usage = isFailure(result) ? undefined : result.usage;
    log.emit({
      level: 'info',
      eventName: 'arki.embed',
      fields: {
        provider: space.provider,
        model: space.model,
        dimensions: callOptions.dimensions ?? space.dimensions,
        inputs: inputs.length,
        tokenBasis: usage?.tokens.basis ?? 'unknown',
        tokens: usage === undefined || usage.tokens.basis === 'unknown' ? undefined : usage.tokens.count,
        requests: usage?.requests ?? 0,
        cacheHits: usage?.cacheHits ?? 0,
        durationMs: Date.now() - started,
        outcome: isFailure(result) ? result.code : 'ok',
        ...(recordInputs ? { texts: inputs.map(input => describeInput(input)) } : {}),
      },
    });
    return result;
  });
}
