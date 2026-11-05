/**
 * Telemetry for embeddings. By default every model call is an OpenTelemetry span with a counter
 * (`observeEmbeddings`, used by the embedder, the sparse embedder and each reranker). `withTelemetry`
 * adds an opt-in `arki.embed` log event per call on top. Safe without an SDK: the API then does
 * nothing, and a telemetry fault never changes a result or hides an error.
 */
import type { Attributes, Span } from '@opentelemetry/api';
import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import { isFailure, isFault } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { Reranker } from './rerank/index.js';
import type { Embedder, EmbeddingsLogger, EmbedInput } from './types.js';
import { withMiddleware } from './middleware.js';

const INSTRUMENTATION = '@arki/embeddings';

/** Runs one reporting call. An SDK that throws cannot reach the caller. */
function quietly(report: () => unknown): void {
  try {
    report();
  } catch {
    // Telemetry is best effort: it has no say over the call it observes.
  }
}

/**
 * Runs one model call inside an `embeddings.<operation>` span (`embeddings.embed`,
 * `embeddings.sparse_embed`, `embeddings.rerank`) and counts it in `embeddings.operations` by
 * `operation`, `provider` and `outcome` (`success`, `failure` for a returned failure, `error` for a
 * throw). A returned failure sets `failure.code`; the span status is error only when
 * `isFault(failure)` (model unavailable, bad output, configuration), not for a refused input, a rate
 * limit or a cancellation. Attributes are bounded: provider, model id, input count, dimensions. Never
 * the input texts, images, queries, documents, vectors, scores or API keys.
 */
export async function observeEmbeddings<T>(
  operation: string,
  attributes: Attributes & { readonly 'embeddings.provider': string },
  execute: () => Promise<T>,
): Promise<T> {
  let span: Span | undefined;
  quietly(() => {
    span = trace.getTracer(INSTRUMENTATION).startSpan(`embeddings.${operation}`, { attributes });
  });
  let outcome = 'success';
  try {
    const result = await execute();
    // `T` is not known to be awaited, and `isFailure` refuses a promise type; the value here is settled.
    const settled: unknown = result;
    if (isFailure(settled)) {
      outcome = 'failure';
      quietly(() => span?.setAttribute('failure.code', settled.code));
      if (isFault(settled)) quietly(() => span?.setStatus({ code: SpanStatusCode.ERROR, message: settled.code }));
    }
    return result;
  } catch (error) {
    outcome = 'error';
    quietly(() => span?.recordException(error instanceof Error ? error : new Error(String(error))));
    quietly(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    throw error;
  } finally {
    const provider = attributes['embeddings.provider'];
    quietly(() =>
      metrics.getMeter(INSTRUMENTATION).createCounter('embeddings.operations').add(1, { operation, provider, outcome }),
    );
    quietly(() => span?.end());
  }
}

/**
 * A reranker's `rerank` with each call in an `embeddings.rerank` span, carrying the provider, the
 * model id and the document count. Every built-in reranker wraps its own `rerank` in this.
 */
export function traceRerank(provider: string, model: string, rerank: Reranker['rerank']): Reranker['rerank'] {
  return (query, documents, options) =>
    observeEmbeddings(
      'rerank',
      { 'embeddings.provider': provider, 'embeddings.model': model, 'embeddings.documents': documents.length },
      () => rerank(query, documents, options),
    );
}

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
 * The same embedder with one `arki.embed` log event per `embed` call, at `info`, on top of the
 * default `embeddings.embed` span. Opt in when you want the call in your logs too: the event carries
 * the duration and, through `@arki/log/otel`, the active trace. Fields: `provider`, `model`, `dimensions`, `inputs` (the count), `tokenBasis`,
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
