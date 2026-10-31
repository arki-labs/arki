/**
 * Spans for the I/O of `@arki/ai`: the Qdrant calls, transcription, the Mastra tool loop and the
 * reconciler. Only the OpenTelemetry API is used, so without an SDK every call here does nothing.
 * A failure (returned or thrown) sets the span status to error and records its code in `failure.code`.
 */
import type { Span } from '@opentelemetry/api';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { isFailure, UnexpectedDefect } from '@arki/failure';

/** The name of the tracer every `@arki/ai` span comes from. */
export const AI_TRACER_NAME = '@arki/ai';

/** Mark `span` as failed with `code`. */
export function failSpan(span: Span, code: string): void {
  span.setAttribute('failure.code', code);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/**
 * Run `run` inside a span called `name`. A returned failure marks the span failed with its code. A thrown
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
    if (isFailure(outcome)) failSpan(span, outcome.code);
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
 * Pass the events of `events` through inside a span called `name`. The span is marked failed with the
 * code of the first event `failureOf` names a failure for, or of a throw. It ends when the stream
 * ends or the consumer stops reading.
 */
export async function* observeAiStream<E>(
  name: string,
  events: AsyncIterable<E>,
  failureOf: (event: E) => { code: string } | undefined,
): AsyncGenerator<E, void, undefined> {
  const span = trace.getTracer(AI_TRACER_NAME).startSpan(name);
  let failed = false;
  try {
    for await (const event of events) {
      const failure = failureOf(event);
      if (failure !== undefined && !failed) {
        failed = true;
        failSpan(span, failure.code);
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
