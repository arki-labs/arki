import type { Attributes } from '@opentelemetry/api';
import { context, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { isFailure, UnexpectedDefect } from '@arki/failure';

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

/** Keep raw throws for retry/fallback; only the public execution boundary normalizes them. */
export async function withPolicySpan<Value>(
  name: string,
  run: () => Value | PromiseLike<Value>,
  attributes?: Attributes,
): Promise<Value> {
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
      if (isFailure<unknown>(result)) {
        observe(() => span?.setAttribute('failure.code', result.code));
        observe(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
      }
    });
    return result;
  } catch (error) {
    observe(() => span?.setAttribute('failure.code', UnexpectedDefect.code));
    observe(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    throw error;
  } finally {
    observe(() => span?.end());
  }
}
