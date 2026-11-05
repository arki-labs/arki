/**
 * Spans and a counter for geocoding lookups and the provider calls under them. Safe without an
 * OpenTelemetry SDK: the API then does nothing. A telemetry fault (a broken SDK or exporter) never
 * changes a result or hides an error.
 *
 * Attributes are bounded and safe: an operation, a provider name, whether the cache answered, a
 * batch size and a failure code. Never the address, the coordinates, the cache key, the provider's
 * message or an API key.
 */
import type { Attributes, Span } from '@opentelemetry/api';
import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import { isFailure, isFault } from '@arki/failure';

const INSTRUMENTATION = '@arki/geo';

/** Runs one reporting call. An SDK that throws cannot reach the caller. */
function quietly(report: () => unknown): void {
  try {
    report();
  } catch {
    // Telemetry is best effort: it has no say over the lookup it observes.
  }
}

/**
 * Runs `execute` with `span` active, so provider spans nest under the lookup span. When the context
 * API throws before `execute` starts, `execute` runs without it.
 */
async function withActiveSpan<T>(span: Span | undefined, execute: () => Promise<T>): Promise<T> {
  if (span === undefined) return execute();
  // An object, not a `let`: the flag is set inside the callback, where narrowing cannot follow it.
  const run = { started: false };
  try {
    return await context.with(trace.setSpan(context.active(), span), () => {
      run.started = true;
      return execute();
    });
  } catch (error) {
    if (run.started) throw error;
    return execute();
  }
}

/** Adds bounded attributes to the running span, such as whether the cache answered. */
export type NoteAttributes = (attributes: Attributes) => void;

/**
 * Runs one geocoding operation inside a `geo.<operation>` span and counts it in `geo.operations` by
 * `operation` and `outcome` (`success`, `failure` for a returned failure, `error` for a throw). A
 * returned failure sets `failure.code`; the span status is error only when `isFault(failure)` (a
 * provider refused or unreachable), not for "nothing found", a rate limit or a cancellation.
 */
export async function observeGeo<T>(
  operation: string,
  attributes: Attributes,
  execute: (note: NoteAttributes) => Promise<T>,
): Promise<T> {
  let span: Span | undefined;
  quietly(() => {
    span = trace.getTracer(INSTRUMENTATION).startSpan(`geo.${operation}`, { attributes });
  });
  const note: NoteAttributes = added => quietly(() => span?.setAttributes(added));
  let outcome = 'success';
  try {
    const result = await withActiveSpan(span, () => execute(note));
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
    quietly(() => metrics.getMeter(INSTRUMENTATION).createCounter('geo.operations').add(1, { operation, outcome }));
    quietly(() => span?.end());
  }
}
