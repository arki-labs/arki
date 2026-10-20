import type { Span } from '@opentelemetry/api';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';

import { isFailure, UnexpectedDefect } from '@arki/failure';

/** Application-owned reporting cannot change resource ownership or its outcome. */
function report(observe: () => unknown): void {
  try {
    void Promise.resolve(observe()).catch(() => {
      // Also observe rejected promises from defective instrumentation.
    });
  } catch {
    // Reporting is best effort.
  }
}

/** Preserve the operation's exact result and run it once, even under a broken context manager. */
export async function observeLocalRuntime<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  let span: Span | undefined;
  report(() => {
    span = trace.getTracer('@arki/db').startSpan(name);
  });
  let execution: Promise<T> | undefined;
  const execute = () => (execution ??= Promise.resolve().then(run));
  report(() => {
    if (span !== undefined) return context.with(trace.setSpan(context.active(), span), execute);
    return;
  });
  const failed = (code: string) => {
    report(() => span?.setAttribute('failure.code', code));
    report(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
  };
  try {
    const result = await execute();
    if (isFailure<unknown>(result)) failed(result.code);
    return result;
  } catch (error) {
    failed(UnexpectedDefect.code);
    throw error;
  } finally {
    report(() => span?.end());
  }
}
