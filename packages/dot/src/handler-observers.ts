/**
 * Ready-made observers for handler events (rpc, http, job, schedule): report
 * the bugs, log the traffic. Both read the `kind: 'handler'` events the kernel
 * fans out to the app's lifecycle observers, so they work on every transport.
 *
 *   defineApp('shop', { observers: [reportErrors({ report: (error, ref) => captureException(error) })] })
 */

import { getLogger } from '@arki/log';

import type { DotLifecycleEvent, DotLifecycleObserver } from './lifecycle-observer.js';
import type { DotHandlerRef } from './unit-contract.js';

const log = getLogger('arki:dot:handlers');

/** What `reportErrors` hands its reporter with the error: the transport, the entry name and the owning feature. */
export type HandlerErrorRef = DotHandlerRef & { readonly feature: string };

export type ReportErrorsOptions = {
  readonly report: (error: unknown, ref: HandlerErrorRef) => void;
};

/**
 * Send a handler's unexpected failures to your error tracker, on any transport.
 *
 * Only `failed` events reach `report`: a thrown bug. A refusal (a returned
 * `Failure`, an oRPC error below 500) is normal traffic, not an incident. The
 * observer cannot change the response: `report` runs synchronously, and a
 * reporter that throws is logged at warn on `arki:dot:handlers` and ignored.
 */
export function reportErrors(options: ReportErrorsOptions): DotLifecycleObserver {
  return event => {
    if (event.kind !== 'handler' || event.status !== 'failed') return;
    const ref = { transport: event.transport, name: event.name, feature: event.feature };
    try {
      options.report(event.error, ref);
    } catch (reportError) {
      log.warn('reportErrors: the reporter threw on {transport} {feature}.{name}; the error was not reported', {
        ...ref,
        reportError: String(reportError),
      });
    }
  };
}

function logHandlerEvent(event: DotLifecycleEvent): void {
  if (event.kind !== 'handler') return;
  if (event.status === 'completed') {
    log.debug('{transport} {feature}.{name} {outcome} {durationMs}ms', {
      transport: event.transport,
      feature: event.feature,
      name: event.name,
      outcome: event.outcome,
      durationMs: event.durationMs,
      ...(event.failure === undefined ? {} : { failure: event.failure.code }),
    });
  } else if (event.status === 'failed') {
    log.debug('{transport} {feature}.{name} failed {durationMs}ms', {
      transport: event.transport,
      feature: event.feature,
      name: event.name,
      durationMs: event.durationMs,
      error: event.error instanceof Error ? event.error : String(event.error),
    });
  }
}

/**
 * Log every handler call at DEBUG on `arki:dot:handlers`: one line when it ends,
 * `rpc digest.preview ok 12ms`, with the error attached when it failed. Opt-in:
 * with no observer registered the kernel emits nothing, so an app that does not
 * mount this pays nothing per call.
 */
export function logHandlers(): DotLifecycleObserver {
  return logHandlerEvent;
}
