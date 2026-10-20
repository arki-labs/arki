import { context, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';

import { UnexpectedDefect } from '@arki/failure';

import { isAuthError } from '../errors.js';

/** Application-owned reporters cannot change authentication or observer completion. */
export function observeSafely<Report>(report: () => Report): Report | undefined {
  try {
    const value = report();
    void Promise.resolve(value).catch(() => {
      // A rejected application reporter cannot reject an authentication operation.
    });
    return value;
  } catch {
    // Instrumentation has no authority over the operation result.
    return;
  }
}

/** Reserve execution once, even when an application context manager calls back twice. */
export async function observeAuth<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  const active = observeSafely(() => context.active());
  const tracer = observeSafely(() => trace.getTracer('@arki/auth'));
  const span = observeSafely(() => tracer?.startSpan(name, undefined, active ?? ROOT_CONTEXT));
  let execution: Promise<T> | undefined;
  const execute = () => (execution ??= Promise.resolve().then(run));
  const scoped = active === undefined || span === undefined ? undefined : observeSafely(() => trace.setSpan(active, span));
  void observeSafely(() => (scoped === undefined ? undefined : context.with(scoped, execute)));
  try {
    const result = await execute();
    if (result instanceof Response) {
      observeSafely(() => span?.setAttribute('http.response.status_code', result.status));
      if (result.status >= 500) observeSafely(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    }
    return result;
  } catch (error) {
    observeSafely(() => span?.setAttribute('failure.code', isAuthError(error) ? error.code : UnexpectedDefect.code));
    observeSafely(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    throw error;
  } finally {
    observeSafely(() => span?.end());
  }
}
