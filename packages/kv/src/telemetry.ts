/**
 * Spans and a counter for every KV command. Safe without an OpenTelemetry SDK: the API then does nothing.
 * A telemetry fault (a broken SDK or exporter) never changes a command's result or hides its error.
 */
import type { Span } from '@opentelemetry/api';
import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import { isFailure } from '@arki/failure';

/** Runs one reporting call. An SDK that throws cannot reach the caller. */
function quietly(report: () => unknown): void {
  try {
    report();
  } catch {
    // Telemetry is best effort: it has no say over the command it observes.
  }
}

/**
 * Run one KV command inside a `kv.<command>` span and count it in `kv.commands` by outcome. A returned
 * failure marks the span failed and sets `failure.code`; a throw is recorded and rethrown unchanged.
 */
export async function observeKv<T>(command: string, execute: () => Promise<T>): Promise<T> {
  let span: Span | undefined;
  quietly(() => {
    span = trace.getTracer('@arki/kv').startSpan(`kv.${command}`);
  });
  let outcome = 'success';
  try {
    const result = await execute();
    const settled: unknown = result;
    if (isFailure(settled)) {
      outcome = 'error';
      quietly(() => span?.setAttribute('failure.code', settled.code));
      quietly(() => span?.setStatus({ code: SpanStatusCode.ERROR, message: settled.code }));
    }
    return result;
  } catch (error) {
    outcome = 'error';
    quietly(() => span?.recordException(error instanceof Error ? error : new Error(String(error))));
    quietly(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    throw error;
  } finally {
    quietly(() => metrics.getMeter('@arki/kv').createCounter('kv.commands').add(1, { command, outcome }));
    quietly(() => span?.end());
  }
}
