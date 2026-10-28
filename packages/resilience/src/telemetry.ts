import type { Attributes, Context } from '@opentelemetry/api';
import { context, metrics, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { isFailure, UnexpectedDefect } from '@arki/failure';
import { startTiming, elapsedTime } from './timing.js';

/** Reporting has no authority over execution, including foreign asynchronous reporters. */
function observe<Report>(report: () => Report): Report | undefined {
  try {
    const value = report();
    void Promise.resolve(value).catch(() => {
      // Observe rejection without waiting for application instrumentation.
    });
    return value;
  } catch {
    return;
  }
}

// Capture this provenance at execution entry: operations started by a reporter must
// not report back into it, even when they finish after the reporting stack unwinds.
let metricReports = 0;
function reportMetric(report: () => void): void {
  if (metricReports > 0) return;
  metricReports++;
  const release = () => { metricReports--; };
  try {
    const result = report();
    if (result === undefined) release();
    else void Promise.resolve(result).then(release, release);
  } catch {
    release();
  }
}

function recordSettlement(name: string, outcome: string, started: ReturnType<typeof startTiming>, current: Context): void {
  const elapsed = elapsedTime(started);
  const attributes = { 'resilience.boundary': name, 'resilience.outcome': outcome };
  reportMetric(() => {
    const meter = observe(() => metrics.getMeter('@arki/resilience'));
    const count = observe(() => meter?.createCounter('resilience.operations', { unit: '{operation}', description: 'Settled owned policy boundaries' }));
    return count?.add(1, attributes, current);
  });
  if (elapsed === undefined) return;
  reportMetric(() => {
    const meter = observe(() => metrics.getMeter('@arki/resilience'));
    const duration = observe(() => meter?.createHistogram('resilience.duration', { unit: 's', description: 'Owned policy boundary time until settlement' }));
    return duration?.record(elapsed / 1000, attributes, current);
  });
}

/** Destination states only: no policy identity or callback reason is exported. @internal */
export function recordCircuitTransition(state: string): void {
  if (metricReports > 0) return;
  const current = observe(() => context.active()) ?? ROOT_CONTEXT;
  const attributes = { 'resilience.circuit.state': state };
  // Count the transition before an event reporter can remain pending.
  reportMetric(() => {
    const meter = observe(() => metrics.getMeter('@arki/resilience'));
    const count = observe(() => meter?.createCounter('resilience.circuit.transitions', { unit: '{transition}', description: 'Circuit breaker state transitions' }));
    return count?.add(1, attributes, current);
  });
  // Reserve reporter provenance for both metrics and span events.
  reportMetric(() => {
    const span = observe(() => trace.getSpan(current));
    const result = observe(() => span?.addEvent('resilience.circuit.state_changed', attributes));
    // The API returns the same span synchronously; a foreign promise retains
    // reporting provenance until it settles, without delaying the operation.
    return result === span ? undefined : result;
  });
}

/** Keep raw throws for retry/fallback; only the public execution boundary normalizes them. */
export async function withPolicySpan<Value>(
  name: string,
  run: () => Value | PromiseLike<Value>,
  attributes?: Attributes,
): Promise<Value> {
  const canReportMetrics = metricReports === 0;
  let started: ReturnType<typeof startTiming>;
  let outcome = 'unclassified';
  const active = observe(() => context.active());
  const tracer = observe(() => trace.getTracer('@arki/resilience'));
  const span = observe(() => tracer?.startSpan(name, { attributes }, active ?? ROOT_CONTEXT));
  let execution: Promise<Value> | undefined;
  // Reserve before context callbacks: repeated, delayed or reentrant calls share work.
  const execute = () => {
    if (execution !== undefined) return execution;
    // Promise constructors assign these synchronously. Reserve before invoking run,
    // but do not postpone work: cancellation ordering must not depend on telemetry.
    let resolveExecution!: (value: Value | PromiseLike<Value>) => void;
    let rejectExecution!: (reason: unknown) => void;
    execution = new Promise<Value>((resolve, reject) => {
      resolveExecution = resolve;
      rejectExecution = reject;
    });
    try {
      started = startTiming();
      resolveExecution(run());
    } catch (error) {
      rejectExecution(error);
    }
    return execution;
  };
  const scoped = active === undefined || span === undefined ? undefined : observe(() => trace.setSpan(active, span));
  void observe(() => (scoped === undefined ? undefined : context.with(scoped, execute)));
  try {
    const result = await execute();
    observe(() => {
      const failed = isFailure<unknown>(result);
      outcome = failed ? 'failure' : 'success';
      if (failed) {
        observe(() => span?.setAttribute('failure.code', result.code));
        observe(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
      }
    });
    return result;
  } catch (error) {
    outcome = 'throw';
    observe(() => span?.setAttribute('failure.code', UnexpectedDefect.code));
    observe(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    throw error;
  } finally {
    if (canReportMetrics) recordSettlement(name, outcome, started, scoped ?? active ?? ROOT_CONTEXT);
    observe(() => span?.end());
  }
}
