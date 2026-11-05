/**
 * Spans for the I/O of `@arki/ai`: the Qdrant calls, transcription, the Mastra tool loop and the
 * reconciler. Only the OpenTelemetry API is used, so without an SDK every call here does nothing.
 * A failure (returned or thrown) records its code in `failure.code`. A throw sets the span status to error.
 * A returned failure sets it only when it is a fault (`isFault`, status 500 or higher): a 4xx such as a
 * rate limit or a refused key is an answer the caller handles, so its status stays unset.
 */
import type { Span } from '@opentelemetry/api';
import type { Failure } from '@arki/failure';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { isFailure, isFault, UnexpectedDefect } from '@arki/failure';

/** The name of the tracer every `@arki/ai` span comes from. */
export const AI_TRACER_NAME = '@arki/ai';

/** Mark `span` as failed with `code`: for a throw, which is always an error. */
export function failSpan(span: Span, code: string): void {
  span.setAttribute('failure.code', code);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/** Record a returned `failure` on `span`: always its `failure.code`, error status only for a fault. */
export function recordFailure(span: Span, failure: Failure): void {
  span.setAttribute('failure.code', failure.code);
  if (isFault(failure)) span.setStatus({ code: SpanStatusCode.ERROR });
}

/**
 * Run `run` inside a span called `name`. A returned failure is recorded with `recordFailure`. A thrown
 * error is recorded on the span and rethrown; its code is the failure's own, or `thrownCode` for a throw
 * that is not a failure (by default `UnexpectedDefect`, a bug).
 */
export async function observeAi<T>(
  name: string,
  run: (span: Span) => Promise<T>,
  { attributes, thrownCode = UnexpectedDefect.code }: { attributes?: Record<string, string | number | boolean>; thrownCode?: string } = {},
): Promise<T> {
  const span = trace.getTracer(AI_TRACER_NAME).startSpan(name, attributes === undefined ? {} : { attributes });
  try {
    const result = await context.with(trace.setSpan(context.active(), span), () => run(span));
    // Seen as `unknown`: whatever `T` is, a returned failure marks the span.
    const outcome: unknown = result;
    if (isFailure(outcome)) recordFailure(span, outcome);
    return result;
  } catch (error) {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    failSpan(span, isFailure(error) ? error.code : thrownCode);
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Pass the events of `events` through inside a span called `name`. The first failure `failureOf` names
 * for an event is recorded with `recordFailure`; a throw marks the span failed. It ends when the stream
 * ends or the consumer stops reading.
 */
export async function* observeAiStream<E>(
  name: string,
  events: AsyncIterable<E>,
  failureOf: (event: E) => Failure | undefined,
): AsyncGenerator<E, void, undefined> {
  const span = trace.getTracer(AI_TRACER_NAME).startSpan(name);
  let failed = false;
  try {
    for await (const event of events) {
      const failure = failureOf(event);
      if (failure !== undefined && !failed) {
        failed = true;
        recordFailure(span, failure);
      }
      yield event;
    }
  } catch (error) {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    failSpan(span, isFailure(error) ? error.code : UnexpectedDefect.code);
    throw error;
  } finally {
    span.end();
  }
}
