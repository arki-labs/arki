import { context, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { isFailure, UnexpectedDefect } from '@arki/failure';


/** Reporting never owns execution, including incorrectly asynchronous app reporters. */
function observe<Report>(report: () => Report): Report | undefined {
  try {
    const value = report();
    void Promise.resolve(value).catch(() => {
      // A rejected app reporter cannot become an unhandled queue rejection.
    });
    return value;
  } catch {
    return;
  }
}

export async function observeQueue<Value>(name: string, work: () => Promise<Value>) {
  const active = observe(() => context.active());
  const tracer = observe(() => trace.getTracer('@arki/offline'));
  const span = observe(() => tracer?.startSpan(name, {}, active ?? ROOT_CONTEXT));
  let execution: ReturnType<typeof work> | undefined;
  const execute = () => (execution ??= Promise.resolve().then(work));
  const scoped = active === undefined || span === undefined ? undefined : observe(() => trace.setSpan(active, span));
  void observe(() => scoped === undefined ? undefined : context.with(scoped, execute));
  try {
    const result = await execute();
    if (isFailure<unknown>(result)) {
      observe(() => span?.setAttribute('failure.code', result.code));
      observe(() => span?.setStatus({ code: SpanStatusCode.ERROR, message: result.code }));
    }
    return result;
  } catch (error) {
    observe(() => span?.setAttribute('failure.code', UnexpectedDefect.code));
    observe(() => span?.setStatus({ code: SpanStatusCode.ERROR, message: UnexpectedDefect.code }));
    return UnexpectedDefect({ cause: error });
  } finally {
    observe(() => span?.end());
  }
}

export function observeEnqueue<Value>(work: () => Promise<Value>) {
  return observeQueue('offline.queue.enqueue', work);
}
