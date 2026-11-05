/**
 * Spans and a counter for the RevenueCat calls. Safe without an OpenTelemetry SDK: the API then does
 * nothing. A telemetry fault (a broken SDK or exporter) never changes a result or hides an error.
 *
 * Names follow the web `@arki/payments` spans: `payments.revenuecat.<method>` like
 * `payments.stripe.<resource>.<method>`, counted in `payments.operations`. Attributes are bounded:
 * the provider, the purchase status and a failure code. Never the API key, the app user id, package
 * or product ids, prices or `CustomerInfo`.
 */
import type { Attributes, Span } from '@opentelemetry/api';
import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import { isFailure, isFault } from '@arki/failure';

const INSTRUMENTATION = '@arki/payments-native';

/** Runs one reporting call. An SDK that throws cannot reach the caller. */
function quietly(report: () => unknown): void {
  try {
    report();
  } catch {
    // Telemetry is best effort: it has no say over the call it observes.
  }
}

/**
 * Runs one RevenueCat call inside a `payments.revenuecat.<operation>` span and counts it in
 * `payments.operations` by `operation` and `outcome` (`success`, `failure` for a returned failure,
 * `error` for a throw). A returned failure sets `failure.code`; the span status is error only when
 * `isFault(failure)`. `describe` adds bounded attributes read from a success (it is not called for a
 * failure), such as a cancelled purchase, which is an answer and leaves the status unset.
 */
export async function observeRevenueCat<T>(
  operation: string,
  execute: () => Promise<T>,
  describe?: (result: T) => Attributes | undefined,
): Promise<T> {
  let span: Span | undefined;
  quietly(() => {
    span = trace
      .getTracer(INSTRUMENTATION)
      .startSpan(`payments.revenuecat.${operation}`, { attributes: { 'payments.provider': 'revenuecat' } });
  });
  let outcome = 'success';
  try {
    const result = await execute();
    // `T` is not known to be awaited, and `isFailure` refuses a promise type; the value here is settled.
    const settled: unknown = result;
    if (isFailure(settled)) {
      outcome = 'failure';
      quietly(() => span?.setAttribute('failure.code', settled.code));
      if (isFault(settled)) quietly(() => span?.setStatus({ code: SpanStatusCode.ERROR, message: settled.code }));
    } else if (describe !== undefined) {
      quietly(() => {
        const attributes = describe(result);
        if (attributes !== undefined) span?.setAttributes(attributes);
      });
    }
    return result;
  } catch (error) {
    outcome = 'error';
    quietly(() => span?.recordException(error instanceof Error ? error : new Error(String(error))));
    quietly(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    throw error;
  } finally {
    quietly(() =>
      metrics
        .getMeter(INSTRUMENTATION)
        .createCounter('payments.operations')
        .add(1, { operation: `revenuecat.${operation}`, outcome }),
    );
    quietly(() => span?.end());
  }
}
