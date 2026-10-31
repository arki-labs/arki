/** Spans and a counter for every KV command. Safe without an OpenTelemetry SDK: the API then does nothing. */
import { isFailure } from '@arki/failure';
import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';

/** Run one KV command inside a `kv.<command>` span and count it in `kv.commands` by outcome. */
export async function observeKv<T>(command: string, execute: () => Promise<T>): Promise<T> {
  const span = trace.getTracer('@arki/kv').startSpan(`kv.${command}`);
  let outcome = 'success';
  try {
    const result = await execute();
    const settled: unknown = result;
    if (isFailure(settled)) {
      outcome = 'error';
      span.setStatus({ code: SpanStatusCode.ERROR, message: settled.code });
    }
    return result;
  } catch (error) {
    outcome = 'error';
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    metrics.getMeter('@arki/kv').createCounter('kv.commands').add(1, { command, outcome });
    span.end();
  }
}
