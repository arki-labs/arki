/**
 * Spans and a counter for sends and provider calls. Safe without an OpenTelemetry SDK: the API then
 * does nothing. A telemetry fault (a broken SDK or exporter) never changes a result or hides an error.
 *
 * Attributes are bounded and safe: an operation, a provider, the transport id and template name the
 * app chose in code, and a failure code. Never addresses, subjects, bodies, headers, tags,
 * idempotency keys, message ids or API keys.
 */
import type { Attributes, Span } from '@opentelemetry/api';
import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import { isFailure, isFault } from '@arki/failure';

import type { MailTransport } from './types.js';

const INSTRUMENTATION = '@arki/mail';

/** Runs one reporting call. An SDK that throws cannot reach the caller. */
function quietly(report: () => unknown): void {
  try {
    report();
  } catch {
    // Telemetry is best effort: it has no say over the send it observes.
  }
}

/**
 * Runs `execute` with `span` active, so the provider spans of a send nest under `mail.send`. When the
 * context API throws before `execute` starts, `execute` runs without it.
 */
async function withActiveSpan<T>(span: Span | undefined, execute: () => Promise<T>): Promise<T> {
  if (span === undefined) return execute();
  // An object, not a `let`: the flag is set inside the callback, where narrowing cannot follow it.
  const run = { started: false };
  try {
    return await context.with(trace.setSpan(context.active(), span), () => {
      run.started = true;
      return execute();
    });
  } catch (error) {
    if (run.started) throw error;
    return execute();
  }
}

/**
 * Runs one mail operation inside a `mail.<operation>` span and counts it in `mail.operations` by
 * `operation` and `outcome` (`success`, `failure` for a returned failure, `error` for a throw). A
 * returned failure sets `failure.code`; the span status is error only when `isFault(failure)`
 * (`mail.uncertain`), not for a refusal the caller handles. A throw (`MailError`, misuse) is recorded
 * and rethrown unchanged.
 */
export async function observeMail<T>(operation: string, attributes: Attributes, execute: () => Promise<T>): Promise<T> {
  let span: Span | undefined;
  quietly(() => {
    span = trace.getTracer(INSTRUMENTATION).startSpan(`mail.${operation}`, { attributes });
  });
  let outcome = 'success';
  try {
    const result = await withActiveSpan(span, execute);
    // `T` is not known to be awaited, and `isFailure` refuses a promise type; the value here is settled.
    const settled: unknown = result;
    if (isFailure(settled)) {
      outcome = 'failure';
      quietly(() => span?.setAttribute('failure.code', settled.code));
      if (isFault(settled)) quietly(() => span?.setStatus({ code: SpanStatusCode.ERROR, message: settled.code }));
    }
    return result;
  } catch (error) {
    outcome = 'error';
    quietly(() => span?.recordException(error instanceof Error ? error : new Error(String(error))));
    quietly(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    throw error;
  } finally {
    quietly(() => metrics.getMeter(INSTRUMENTATION).createCounter('mail.operations').add(1, { operation, outcome }));
    quietly(() => span?.end());
  }
}

/**
 * The same transport with each send in a `mail.<provider>.send` span (`mail.resend.send`), carrying
 * `mail.provider` and `mail.transport`. Every provider transport wraps itself in this, so a failover
 * shows one provider span per attempt under the `mail.send` span.
 */
export function traceTransport(provider: string, transport: MailTransport): MailTransport {
  const attributes = { 'mail.provider': provider, 'mail.transport': transport.id };
  return {
    ...transport,
    send: (message, options) => observeMail(`${provider}.send`, attributes, () => transport.send(message, options)),
  };
}
