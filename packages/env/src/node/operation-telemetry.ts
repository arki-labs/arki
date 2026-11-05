import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import packageMetadata from '@arki/env/package.json' with { type: 'json' };
import { isFailure, isFault } from '@arki/failure';

function observe<Value>(fn: () => Value) {
  try {
    const value = fn();
    void Promise.resolve(value).catch(() => {
      /* Reporting never owns execution. */
    });
    return value;
  } catch {
    return;
  }
}

/**
 * Safe execution-boundary telemetry; never records paths, references, values, keys or raw causes.
 * A returned failure sets `failure.code`; the status is error for a throw, and for a returned failure
 * only when it is a fault (`isFault`, status 500 or higher). A 4xx leaves the status unset.
 */
export function nodeOperation<Value>(name: string, run: () => Value): Value {
  const span = observe(() => trace.getTracer('@arki/env', packageMetadata.version).startSpan(`env.${name}`));
  const active = observe(() => (span === undefined ? context.active() : trace.setSpan(context.active(), span)));
  const started = Date.now();
  const invocation: { outcome?: { value: Value } | { cause: unknown } } = {};
  const invoke = () => {
    if (invocation.outcome === undefined) {
      try {
        invocation.outcome = { value: run() };
      } catch (error) {
        invocation.outcome = { cause: error };
      }
    }
    if ('cause' in invocation.outcome) throw invocation.outcome.cause;
    return invocation.outcome.value;
  };
  let result: Value | undefined;
  try {
    if (active !== undefined) observe(() => context.with(active, invoke));
    result = invoke();
    return result;
  } finally {
    const outcome: unknown = result;
    const thrown = invocation.outcome !== undefined && 'cause' in invocation.outcome;
    const failure = isFailure(outcome) ? outcome : undefined;
    const failed = failure !== undefined || thrown;
    if (failure !== undefined) observe(() => span?.setAttribute('failure.code', failure.code));
    if (thrown || (failure !== undefined && isFault(failure)))
      observe(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    else if (!failed) observe(() => span?.setStatus({ code: SpanStatusCode.OK }));
    observe(() =>
      metrics
        .getMeter('@arki/env', packageMetadata.version)
        .createHistogram('env.operation.duration', { unit: 'ms' })
        .record(
          Math.max(0, Date.now() - started),
          { 'env.operation': name, 'env.outcome': failed ? 'failed' : 'ok' },
          active,
        ),
    );
    observe(() => span?.end());
  }
}
