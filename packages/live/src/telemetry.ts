/**
 * Spans and metrics for live streams, through `@opentelemetry/api` only: with no SDK registered
 * every call does nothing and exports nothing. A telemetry fault (a broken SDK, exporter or
 * context manager) never changes a stream, runs work twice or hides an error.
 *
 * One span per stream's life on the server (`live.stream`) and per connection on the client
 * (`live.client.connection`), never one per frame. Never recorded: cursors, grants, scope keys,
 * table names, frame contents, URLs, headers, error messages.
 */
import type { Span } from '@opentelemetry/api';
import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import { isLiveError } from './errors.js';

const SCOPE = '@arki/live';

/** Why a server stream ended, as the `live.stream.end` attribute and the `live.streams` dimension. */
export type LiveStreamEnd =
  /** `maxAgeMs` passed: `bye`, the client reconnects and is authorized again. */
  | 'max_age'
  /** A `reauthorize` write changed or refused the grant: `bye`. */
  | 'revoked'
  /** The endpoint was closed (app stop). */
  | 'closed'
  /** The hub ended the stream with `gap` (its source lost the listener). */
  | 'gap'
  /** The hub ended the stream with `bye` (a slow client, the hub stopping). */
  | 'bye'
  /** Attaching or reading the hub's feed failed. */
  | 'error'
  /** The request went away (the client closed it). */
  | 'disconnected';

/** How a client connection ended, as the `live.client.outcome` attribute and the `live.client.connections` dimension. */
export type LiveConnectionOutcome =
  /** The server sent `bye`: reconnect at once with the cursor. */
  | 'bye'
  /** A failure (a dropped or idle connection, 5xx, `gap`, a bad frame, a throwing `onEvent`): back off and reconnect. */
  | 'retry'
  /** 401 or 403: the client stops. */
  | 'unauthorized'
  /** `stop()` ended it. */
  | 'stopped'
  /** It cannot work (`fetch` gave no streaming body): the client stops. */
  | 'error';

/** Runs one reporting call. An SDK that throws cannot reach the caller. */
function quietly(report: () => unknown): void {
  try {
    report();
  } catch {
    // Telemetry is best effort: it has no say over the stream it observes.
  }
}

/** A bounded name for a thrown error: the `ARKI_LIVE_E…` code, else the error class. Never the message. */
function errorType(error: unknown): string {
  if (isLiveError(error)) return error.code;
  return error instanceof Error ? error.name : typeof error;
}

function startSpan(name: string): Span | undefined {
  let span: Span | undefined;
  quietly(() => {
    span = trace.getTracer(SCOPE).startSpan(name);
  });
  return span;
}

/** The telemetry of one server stream: started in `open`, ended once by the first `end`. */
export type StreamTelemetry = {
  /** The stream's first frame: whether its cursor resumed or reset. */
  readonly begin: (mode: 'resume' | 'reset') => void;
  /** Ends the span and the active count. Later calls do nothing. `error` marks the span failed. */
  readonly end: (reason: LiveStreamEnd, error?: unknown) => void;
};

/** Starts a `live.stream` span (under the request's span, when there is one) and counts the stream in `live.streams.active`. */
export function observeStream(): StreamTelemetry {
  const span = startSpan('live.stream');
  quietly(() => metrics.getMeter(SCOPE).createUpDownCounter('live.streams.active').add(1));
  let ended = false;
  return {
    begin(mode) {
      quietly(() => span?.setAttribute('live.stream.mode', mode));
    },
    end(reason, error) {
      if (ended) return;
      ended = true;
      quietly(() => span?.setAttribute('live.stream.end', reason));
      if (error !== undefined) quietly(() => span?.setAttribute('error.type', errorType(error)));
      if (reason === 'error' || reason === 'gap') quietly(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
      quietly(() => metrics.getMeter(SCOPE).createUpDownCounter('live.streams.active').add(-1));
      quietly(() => metrics.getMeter(SCOPE).createCounter('live.streams').add(1, { end: reason }));
      quietly(() => span?.end());
    },
  };
}

type Ran<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** The telemetry of one client connection, from its `fetch` until it ends. */
export type ConnectionTelemetry = {
  /** Calls `connect` once with the span active, so an instrumented `fetch` joins the trace. */
  readonly run: <T>(connect: () => T) => T;
  /** The HTTP status the server answered. */
  readonly status: (code: number) => void;
  /** Ends the span and counts the connection. Later calls do nothing. */
  readonly end: (outcome: LiveConnectionOutcome, error?: unknown) => void;
};

/** Starts a `live.client.connection` span. `attempt` is the number of failed connects since the last `hello`. */
export function observeConnection(attempt: number): ConnectionTelemetry {
  const span = startSpan('live.client.connection');
  quietly(() => span?.setAttribute('live.client.attempt', attempt));
  let ended = false;
  return {
    run<T>(connect: () => T): T {
      let ran: Ran<T> | undefined;
      const once = (): Ran<T> => {
        if (ran !== undefined) return ran;
        try {
          ran = { ok: true, value: connect() };
        } catch (error) {
          ran = { ok: false, error };
        }
        return ran;
      };
      if (span !== undefined) quietly(() => context.with(trace.setSpan(context.active(), span), once));
      const settled = once();
      if (!settled.ok) throw settled.error;
      return settled.value;
    },
    status(code) {
      quietly(() => span?.setAttribute('http.response.status_code', code));
    },
    end(outcome, error) {
      if (ended) return;
      ended = true;
      quietly(() => span?.setAttribute('live.client.outcome', outcome));
      if (error !== undefined) quietly(() => span?.setAttribute('error.type', errorType(error)));
      if (outcome === 'retry' || outcome === 'unauthorized' || outcome === 'error') {
        quietly(() => span?.setStatus({ code: SpanStatusCode.ERROR }));
      }
      quietly(() => metrics.getMeter(SCOPE).createCounter('live.client.connections').add(1, { outcome }));
      quietly(() => span?.end());
    },
  };
}
