import type { Span } from '@opentelemetry/api';
import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import { isFault } from '@arki/failure';

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
    const failure =
      result.status === 'refused'
        ? result.failure
        : result.status === 'handler-failed' || result.status === 'lock-failed'
          ? result.cause
          : undefined;
    observe(() => span?.setAttribute('schedule.outcome', result.status));
    // A failure always sets `failure.code`. Only a fault (5xx) sets the error status: an expected
    // refusal (4xx) is an answer, not an error, so its status stays unset.
    if (failure === undefined) observe(() => span?.setStatus({ code: SpanStatusCode.OK }));
    else {
      observe(() => span?.setAttribute('failure.code', failure.code));
      if (isFault(failure)) observe(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    }
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
