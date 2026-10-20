import type { Span } from '@opentelemetry/api';
import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import type { ScheduleRunResult } from './runtime.js';

/** Instrumentation never owns execution or changes a scheduling outcome. */
export function observe<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

/** One execution boundary; payloads, lock keys and private causes are never attributes. */
export async function observeSchedule(name: string, run: () => Promise<ScheduleRunResult>): Promise<ScheduleRunResult> {
  const started = performance.now();
  const span: Span | undefined = observe(() =>
    trace.getTracer('@arki/schedule').startSpan('schedule.run', { attributes: { 'schedule.name': name } }),
  );
  let pending: Promise<ScheduleRunResult> | undefined;
  if (span !== undefined) {
    observe(() =>
      context.with(trace.setSpan(context.active(), span), () => {
        pending = run();
      }),
    );
  }
  // A context manager may fail before OR after calling run. Never execute twice.
  pending ??= run();
  try {
    const result = await pending;
    const failed = result.status === 'refused' || result.status === 'handler-failed' || result.status === 'lock-failed';
    observe(() => span?.setAttribute('schedule.outcome', result.status));
    observe(() => span?.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK }));
    observe(() =>
      metrics
        .getMeter('@arki/schedule')
        .createHistogram('schedule.run.duration', { unit: 'ms' })
        .record(performance.now() - started, { 'schedule.outcome': result.status }),
    );
    return result;
  } finally {
    observe(() => span?.end());
  }
}
