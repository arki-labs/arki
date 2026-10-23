/**
 * OpenTelemetry spans for the journal's three execution boundaries:
 * - `journal.command`: one command run, inside its transaction, around the app's command hooks.
 * - `journal.effect`: one effect attempt, inside its lease, around the app's effect hooks.
 * - `journal.step`: the body (or the undo) of one workflow step attempt. It runs inside the `workflow.step` effect,
 *   which also loads the run, writes the checkpoint and routes, so the step span is a narrower boundary, not a copy.
 *
 * Telemetry never owns the work. A tracer, context manager or span that throws is ignored, the work runs exactly
 * once, and its result or throw passes through unchanged. A returned failure is recorded as `failure.code` with
 * `journal.outcome = failure`, never as an exception event; a throw is `journal.outcome = defect`. Inputs, payloads,
 * meta, results and error messages are never attributes. With no SDK installed, every call is a no-op.
 * Leaf file.
 */
import type { Attributes, Span } from '@opentelemetry/api';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';

import { isFailure } from '@arki/failure';

/** The span names the journal emits. */
export const JOURNAL_SPANS = ['journal.command', 'journal.effect', 'journal.step'] as const;
export type JournalSpan = (typeof JOURNAL_SPANS)[number];

/** The values of the `journal.outcome` attribute. */
export const JOURNAL_OUTCOMES = ['ok', 'failure', 'defect'] as const;
export type JournalOutcome = (typeof JOURNAL_OUTCOMES)[number];

/** Runs an instrumentation call; a throw from it is dropped. */
function observe<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

/** Runs `work` inside span `name`, as the active span, so commands it runs become child spans. */
export async function withJournalSpan<T>(
  name: JournalSpan,
  attributes: Attributes,
  work: () => Promise<T>,
): Promise<T> {
  const span: Span | undefined = observe(() => trace.getTracer('@arki/journal').startSpan(name, { attributes }));
  let pending: Promise<T> | undefined;
  const once = (): Promise<T> => (pending ??= work());
  // A context manager may throw before or after it calls `once`. `once` keeps the work to one run either way.
  if (span !== undefined) void observe(() => context.with(trace.setSpan(context.active(), span), once));
  const outcome = (value: JournalOutcome) => observe(() => span?.setAttribute('journal.outcome', value));
  try {
    const result = await once();
    if (isFailure<unknown>(result)) {
      outcome('failure');
      observe(() => span?.setAttribute('failure.code', result.code));
      observe(() => span?.setStatus({ code: SpanStatusCode.ERROR, message: result.code }));
    } else {
      outcome('ok');
    }
    return result;
  } catch (error) {
    outcome('defect');
    observe(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
    throw error;
  } finally {
    observe(() => span?.end());
  }
}
