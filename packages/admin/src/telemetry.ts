/**
 * A span and a counter for each Foreman execute this app runs. Safe without an OpenTelemetry SDK: the
 * API then does nothing. A telemetry fault never changes the action's result or hides its failure.
 *
 * Attributes are bounded: the action id (one of the app's registered actions), the receipt outcome
 * and a failure code. Never the input, the result, the execution id, the approver or a key.
 */
import type { Span } from '@opentelemetry/api';
import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import { isFailure, isFault, UnexpectedDefect } from '@arki/failure';

import type { SettledReceipt } from './receipts.ts';

const INSTRUMENTATION = '@arki/admin';

/**
 * What became of the execution's receipt: settled as `applied` or `failed`, left `pending` because the
 * store could not settle it, `replayed` from an earlier receipt (the action did not run), or
 * `unclaimed` because the store refused the claim (the action did not run).
 */
export type ReceiptOutcome = SettledReceipt['status'] | 'pending' | 'replayed' | 'unclaimed';

/** Run `report`; a throwing SDK or exporter cannot reach the action. */
function report(run: () => void): void {
  try {
    run();
  } catch {
    /* Telemetry is best effort. */
  }
}

/**
 * Run one approved execute inside an `admin.action.execute` span and count it in `admin.executions`.
 * `run` reports the receipt outcome through its argument; the span carries it as `admin.receipt`. A
 * returned failure, or a throw, sets `failure.code`. The span status is error for a throw, and for a
 * returned failure only when it is a fault (`isFault`, status 500 or higher): a 4xx is an answer.
 */
export async function observeExecute<T>(
  actionId: string,
  run: (receipt: (outcome: ReceiptOutcome) => void) => Promise<T>,
): Promise<T> {
  let span: Span | undefined;
  report(() => {
    span = trace
      .getTracer(INSTRUMENTATION)
      .startSpan('admin.action.execute', { attributes: { 'admin.action': actionId } });
  });
  let active = context.active();
  report(() => {
    if (span !== undefined) active = trace.setSpan(context.active(), span);
  });
  let receipt: ReceiptOutcome | undefined;
  let code: string | undefined;
  let fault = false;
  try {
    const result = await context.with(active, () =>
      run(outcome => {
        receipt = outcome;
      }),
    );
    // `T` is not known to be awaited, and `isFailure` refuses a promise type; the value here is settled.
    const settled: unknown = result;
    if (isFailure(settled)) {
      code = settled.code;
      fault = isFault(settled);
    }
    return result;
  } catch (error) {
    code = isFailure(error) ? error.code : UnexpectedDefect.code;
    fault = true;
    report(() => span?.recordException(error instanceof Error ? error : new Error(String(error))));
    throw error;
  } finally {
    const failureCode = code;
    const receiptOutcome = receipt;
    if (receiptOutcome !== undefined) report(() => span?.setAttribute('admin.receipt', receiptOutcome));
    if (failureCode !== undefined) {
      report(() => span?.setAttribute('failure.code', failureCode));
      if (fault) report(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    }
    report(() => span?.end());
    report(() =>
      metrics
        .getMeter(INSTRUMENTATION)
        .createCounter('admin.executions')
        .add(1, {
          action: actionId,
          receipt: receiptOutcome ?? 'none',
          outcome: failureCode === undefined ? 'success' : 'failure',
        }),
    );
  }
}
