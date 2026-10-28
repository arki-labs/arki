/** Best-effort observation of an owned lifetime; no SDK or platform context manager is installed here. */
import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import type { Failure } from '@arki/failure';
import packageMetadata from '@arki/async/package.json' with { type: 'json' };

import { Cancelled, Deadline } from './errors.js';
import { runObservedContext } from './operation-telemetry.js';
import { systemClock } from './system-clock.js';

function observe<Value>(report: () => Value): Value | undefined {
  try {
    const value = report();
    void Promise.resolve(value).catch(() => {
      /* Reporting never owns execution. */
    });
    return value;
  } catch {
    return undefined;
  }
}

/** One span per owner, kept open through cancellation, joining and finalization. */
export function scopeTelemetry() {
  const span = observe(() => trace.getTracer('@arki/async', packageMetadata.version).startSpan('async.scope'));
  const ownedContext = observe(() => (span === undefined ? context.active() : trace.setSpan(context.active(), span)));
  const started = observe(() => systemClock.now().getTime());
  return {
    /** A defective context manager must never skip, replay or replace user work. */
    run<Value>(this: void, run: () => Value): Value {
      return runObservedContext(ownedContext, run);
    },
    end(outcome: void | Failure, primary: readonly Failure[], cleanup: readonly Failure[], finalizers: number) {
      observe(() => {
        span?.setAttributes({
          'async.scope.primary.count': primary.length,
          'async.scope.cleanup.count': cleanup.length,
          'async.scope.finalizer.count': finalizers,
          'async.scope.cancelled': primary.some(failure => Cancelled.is(failure)),
          'async.scope.deadline': primary.some(failure => Deadline.is(failure)),
        });
      });
      observe(() => {
        span?.setStatus({ code: outcome === undefined ? SpanStatusCode.OK : SpanStatusCode.ERROR });
        if (outcome !== undefined)
          span?.setAttributes({ 'failure.code': outcome.code, 'failure.status': outcome.status });
      });
      observe(() => {
        if (started === undefined) return;
        metrics
          .getMeter('@arki/async', packageMetadata.version)
          .createHistogram('async.scope.duration', { description: 'Owned lifetime through finalization.', unit: 'ms' })
          .record(
            Math.max(0, systemClock.now().getTime() - started),
            { 'async.scope.outcome': outcome === undefined ? 'ok' : 'failed' },
            ownedContext,
          );
      });
      observe(() => span?.end());
    },
  };
}
