import type { Span } from '@opentelemetry/api';
import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import { isFailure, UnexpectedDefect } from '@arki/failure';

/** Reporting must never change ownership, replay execution, or reject unobserved. */
export function report(observe: () => unknown): void {
  try {
    void Promise.resolve(observe()).catch(() => { /* A rejected reporting result cannot affect ownership. */ });
  } catch {
    // An application-owned observer cannot change an operation outcome.
  }
}

/** Meaningful ownership boundaries, safe without an SDK and under defective providers. */
export async function observeLock<T>(operation: string, execute: () => Promise<T>): Promise<T> {
  let span: Span | undefined;
  report(() => {
    const tracer = trace.getTracer('@arki/lock');
    report(() => tracer);
    span = tracer.startSpan(`lock.${operation}`);
    return span;
  });
  let execution: Promise<T> | undefined;
  const once = () => (execution ??= (async () => await execute())());
  report(() => {
    if (span === undefined) return;
    const active = context.active();
    report(() => active);
    const scoped = trace.setSpan(active, span);
    report(() => scoped);
    return context.with(scoped, once);
  });
  let code = 'success';
  try {
    const result = await once();
    if (isFailure<unknown>(result)) {
      code = result.code === 'lock.held' ? 'held' : UnexpectedDefect.is(result) ? 'defect' : 'failure';
      report(() => span?.setAttribute('failure.code', result.code));
      report(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    }
    return result;
  } catch (error) {
    code = 'defect';
    report(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    throw error;
  } finally {
    report(() => {
      const meter = metrics.getMeter('@arki/lock');
      report(() => meter);
      const counter = meter.createCounter('lock.operations');
      report(() => counter);
      return counter.add(1, { operation, outcome: code });
    });
    report(() => span?.end());
  }
}
