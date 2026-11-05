/**
 * Spans and a counter for publishes, deliveries and SQLite polls, through `@opentelemetry/api` only:
 * with no SDK registered every call does nothing and exports nothing. A telemetry fault (a broken
 * SDK, exporter or context manager) never changes a result, runs work twice or hides an error.
 *
 * Never recorded: channel names, payloads, error messages (they can quote a channel).
 */
import type { Attributes, Span, TimeInput } from '@opentelemetry/api';
import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import { PubSubError } from './errors.js';

const SCOPE = '@arki/pubsub';

/** The backend, as the `pubsub.backend` attribute and metric dimension. */
export type PubSubBackend = 'memory' | 'pg' | 'redis' | 'sqlite';

/** What `pubsub.operations` counts, as its `operation` dimension. */
type PubSubOperation = 'publish' | 'publish_in' | 'deliver' | 'poll';

/** Runs one reporting call. An SDK that throws cannot reach the caller. */
function quietly(report: () => unknown): void {
  try {
    report();
  } catch {
    // Telemetry is best effort: it has no say over the operation it observes.
  }
}

function startSpan(name: string, attributes: Attributes, startTime?: TimeInput): Span | undefined {
  let span: Span | undefined;
  quietly(() => {
    span = trace.getTracer(SCOPE).startSpan(name, startTime === undefined ? { attributes } : { attributes, startTime });
  });
  return span;
}

/** A bounded name for a thrown error: the `ARKI_PUBSUB_E…` id, else the error class. Never the message. */
function errorType(error: unknown): string {
  if (error instanceof PubSubError) return error.errorCode;
  return error instanceof Error ? error.name : typeof error;
}

function failSpan(span: Span | undefined, error: unknown): void {
  quietly(() => span?.setAttribute('error.type', errorType(error)));
  quietly(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
}

function count(operation: PubSubOperation, backend: PubSubBackend, outcome: 'success' | 'error'): void {
  quietly(() => metrics.getMeter(SCOPE).createCounter('pubsub.operations').add(1, { operation, backend, outcome }));
}

type Ran<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * Calls `run` exactly once with `span` active, so spans the work starts (the driver's, a
 * subscriber's) nest under it. A context manager that throws cannot skip the call, repeat it or
 * swallow what it threw.
 */
function inSpan<T>(span: Span | undefined, run: () => T): T {
  let ran: Ran<T> | undefined;
  const once = (): Ran<T> => {
    if (ran !== undefined) return ran;
    try {
      ran = { ok: true, value: run() };
    } catch (error) {
      ran = { ok: false, error };
    }
    return ran;
  };
  if (span !== undefined) quietly(() => context.with(trace.setSpan(context.active(), span), once));
  const settled = once();
  if (!settled.ok) throw settled.error;
  return settled.value;
}

/** One `publish` or `publishIn` in a `pubsub.publish` / `pubsub.publish_in` span, counted by outcome. Errors pass through unchanged. */
export async function observePublish(
  operation: 'publish' | 'publish_in',
  backend: PubSubBackend,
  execute: () => Promise<void>,
): Promise<void> {
  const span = startSpan(`pubsub.${operation}`, { 'pubsub.backend': backend });
  try {
    await inSpan(span, execute);
    count(operation, backend, 'success');
  } catch (error) {
    failSpan(span, error);
    count(operation, backend, 'error');
    throw error;
  } finally {
    quietly(() => span?.end());
  }
}

/**
 * One delivery to one subscriber in a `pubsub.deliver` span: from the call until the callback
 * returns, or until the promise it returned settles. `fail` gets what the callback threw or
 * rejected with; the span is marked failed either way.
 */
export function observeDelivery(
  backend: PubSubBackend,
  onMessage: () => unknown,
  fail: (error: unknown) => void,
): void {
  const span = startSpan('pubsub.deliver', { 'pubsub.backend': backend });
  const settle = (error?: { readonly thrown: unknown }): void => {
    if (error !== undefined) {
      fail(error.thrown);
      failSpan(span, error.thrown);
    }
    count('deliver', backend, error === undefined ? 'success' : 'error');
    quietly(() => span?.end());
  };
  let result: unknown;
  try {
    result = inSpan(span, onMessage);
  } catch (error) {
    settle({ thrown: error });
    return;
  }
  if (result instanceof Promise) {
    result.then(
      () => settle(),
      (error: unknown) => settle({ thrown: error }),
    );
    return;
  }
  settle();
}

/**
 * One SQLite poll that has finished its read. Every poll is counted. Only a poll that read rows
 * or failed gets a `pubsub.sqlite.poll` span (started at `startTime`, so it covers the read): an
 * idle poll every `intervalMs` is not worth a trace. `deliverRows` runs inside that span, so each
 * `pubsub.deliver` nests under the poll that read its row.
 */
export function observePoll(
  startTime: number,
  read: { readonly rows: number } | { readonly rows: 0; readonly thrown: unknown },
  deliverRows: () => void,
): void {
  const failed = 'thrown' in read;
  count('poll', 'sqlite', failed ? 'error' : 'success');
  if (read.rows === 0 && !failed) {
    deliverRows();
    return;
  }
  const span = startSpan('pubsub.sqlite.poll', { 'pubsub.backend': 'sqlite', 'pubsub.messages': read.rows }, startTime);
  if (failed) failSpan(span, read.thrown);
  try {
    inSpan(span, deliverRows);
  } finally {
    quietly(() => span?.end());
  }
}
