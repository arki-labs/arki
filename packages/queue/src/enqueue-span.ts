import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { isFailure, UnexpectedDefect } from '@arki/failure';

/** Application telemetry never owns an enqueue outcome. */
function observe<Report>(report: () => Report): Report | undefined {
  try {
    const value = report();
    void Promise.resolve(value).catch(() => {
      // A rejected asynchronous reporter cannot reject the owned operation.
    });
    return value;
  } catch {
    // Application instrumentation is best effort.
    return;
  }
}

/** Reserve the operation before telemetry callbacks can invoke it again. */
export async function withEnqueueSpan<Value>(
  run: () => Value | Promise<Value>,
  jobName?: string,
  spanName = 'queue.enqueue',
): Promise<Value | ReturnType<typeof UnexpectedDefect>> {
  const active = observe(() => context.active());
  const tracer = observe(() => trace.getTracer('@arki/queue'));
  const span = observe(() =>
    tracer?.startSpan(
      spanName,
      {
        kind: SpanKind.PRODUCER,
        attributes: jobName === undefined ? {} : { 'messaging.destination.name': jobName },
      },
      active ?? ROOT_CONTEXT,
    ),
  );
  let execution: Promise<Value> | undefined;
  const execute = () => (execution ??= Promise.resolve().then(run));
  const scoped = active === undefined || span === undefined ? undefined : observe(() => trace.setSpan(active, span));
  void observe(() => (scoped === undefined ? undefined : context.with(scoped, execute)));
  try {
    const result = await execute();
    if (isFailure<unknown>(result)) {
      observe(() => span?.setAttribute('failure.code', result.code));
      observe(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    }
    return result;
  } catch (error) {
    observe(() => span?.setAttribute('failure.code', UnexpectedDefect.code));
    observe(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    return UnexpectedDefect({ cause: error });
  } finally {
    observe(() => span?.end());
  }
}
