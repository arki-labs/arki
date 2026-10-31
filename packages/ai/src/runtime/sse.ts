import { z } from 'zod';

import { InvalidEnvelope, isFailure, revive, serialize } from '@arki/failure';
import { parse } from '@arki/schema';

import type { RuntimeEvent, RuntimeFailure } from './types.js';
import { debugRuntime } from '../debug.js';
import { ConnectionLost } from '../failures.js';
import { connectionFailure, RUNTIME_FAILURES, thrownRunFailure } from './types.js';

/**
 * SSE transport for the agent-runtime adapter (P2 completion). Completes the wire:
 *
 *   server:  runToolLoop(input)  ──toRuntimeEventStreamResponse──▶  text/event-stream
 *   client:  readRuntimeEventStream(response)  ──▶  AsyncIterable<RuntimeEvent>  ──▶  useRuntimeStream
 *
 * Web-standard (`Response` / `ReadableStream` / `TextEncoder`), so it runs on Bun, Node 18+,
 * edge runtimes, and the browser. `RuntimeEvent`s are JSON-serialized one per SSE `data:` frame,
 * terminated by a `[DONE]` sentinel. A `run:error` travels as its failure's envelope
 * (`serialize` from `@arki/failure`) and comes back as the same failure (`revive`), so its code
 * and data survive the wire.
 */
const DONE = '[DONE]';

/** A RuntimeEvent as JSON carries it: `run:error` holds its failure's envelope, every other event is itself. */
export type RuntimeWireEvent = Exclude<RuntimeEvent, { type: 'run:error' }> | { type: 'run:error'; failure: unknown };

/** JSON text, parsed. Text that is not JSON is a schema issue like any other, so `parse` returns `InvalidInput`. */
export const jsonTextSchema = z.string().transform((text, context): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    context.addIssue({ code: 'custom', message: 'Expected JSON text' });
    return z.NEVER;
  }
});

const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
});

/** One {@link RuntimeWireEvent}. A two-way type test in `sse.test.ts` locks it to the type. */
export const runtimeWireEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run:start') }),
  z.object({ type: z.literal('text:delta'), delta: z.string() }),
  z.object({ type: z.literal('tool:start'), tool: z.string(), args: z.unknown() }),
  z.object({ type: z.literal('tool:result'), tool: z.string(), result: z.unknown() }),
  z.object({
    type: z.literal('tool:failure'),
    tool: z.string(),
    failure: z
      .object({ code: z.string(), message: z.string(), remediation: z.string().optional(), data: z.unknown() })
      // JSON drops an undefined remediation; a ToolFailure always has the key.
      .transform(failure => ({ ...failure, remediation: failure.remediation })),
  }),
  z.object({ type: z.literal('tool:error'), tool: z.string(), error: z.string() }),
  z.object({ type: z.literal('run:finish'), text: z.string(), usage: usageSchema.optional() }),
  z.object({ type: z.literal('run:error'), failure: z.unknown() }),
]);

/** One SSE frame's data: JSON text holding a {@link RuntimeWireEvent}. */
const runtimeFrameSchema = jsonTextSchema.pipe(runtimeWireEventSchema);

/** The body of a non-OK response: `{ error: envelope }`, the error body `@arki/http` answers with. */
const failureBodySchema = jsonTextSchema.pipe(z.object({ error: z.unknown() }));

function runError(failure: RuntimeFailure): RuntimeEvent {
  return { type: 'run:error', failure };
}

function toWire(event: RuntimeEvent): RuntimeWireEvent {
  if (event.type !== 'run:error') return event;
  const envelope = serialize(event.failure, RUNTIME_FAILURES);
  // A failure whose data is not JSON cannot travel as itself; the InvalidEnvelope saying so can.
  return { type: 'run:error', failure: isFailure(envelope) ? serialize(envelope, RUNTIME_FAILURES) : envelope };
}

function fromWire(event: RuntimeWireEvent): RuntimeEvent {
  if (event.type !== 'run:error') return event;
  return runError(revive(event.failure, RUNTIME_FAILURES) ?? InvalidEnvelope({ reason: 'malformed' }));
}

/**
 * Server: serialize a RuntimeEvent stream as an SSE `Response`. A source that throws ends with a
 * `run:error` frame carrying its failure (a provider failure stays itself, an abort is `Cancelled`,
 * anything else is `UnexpectedDefect`). When the client goes away the response stops reading the
 * source and calls its `return()`; also pass the request's `signal` to `runToolLoop` so the model
 * call in flight is aborted at once.
 */
export function toRuntimeEventStreamResponse(events: AsyncIterable<RuntimeEvent>, init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const frame = (data: string) => encoder.encode(`data: ${data}\n\n`);
  const iterator = events[Symbol.asyncIterator]();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (!next.done) {
          controller.enqueue(frame(JSON.stringify(toWire(next.value))));
          return;
        }
      } catch (error) {
        const failure = thrownRunFailure(error);
        debugRuntime.debug('toRuntimeEventStreamResponse: the event source threw ({code})', { code: failure.code });
        controller.enqueue(frame(JSON.stringify(toWire(runError(failure)))));
      }
      controller.enqueue(frame(DONE));
      controller.close();
    },
    async cancel() {
      debugRuntime.debug('toRuntimeEventStreamResponse: the client went away, stopping the source');
      await iterator.return?.();
    },
  });

  return new Response(stream, {
    ...init,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      ...init?.headers,
    },
  });
}

/**
 * Client: decode an SSE `Response` (or raw body stream) back into RuntimeEvents. Every frame is
 * checked by a schema. The stream always ends with one terminal event: the server's `run:finish`
 * or `run:error`, or a `run:error` of its own when a frame is malformed (`InvalidInput`), the body
 * breaks (`ConnectionLost`, or `Cancelled` on an abort) or ends before a terminal event (`ConnectionLost`).
 */
export async function* readRuntimeEventStream(
  input: Response | ReadableStream<Uint8Array>,
  signal?: AbortSignal | null,
): AsyncIterable<RuntimeEvent> {
  const body = input instanceof Response ? input.body : input;
  if (!body) {
    yield runError(ConnectionLost());
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        yield runError(connectionFailure(error, signal));
        return;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const data = rawFrame.startsWith('data:') ? rawFrame.slice(5).trim() : rawFrame.trim();
        if (data.length === 0 || data === DONE) continue;
        const event = parse(runtimeFrameSchema, data);
        if (isFailure(event)) {
          debugRuntime.debug('readRuntimeEventStream: malformed SSE frame ({code})', { code: event.code });
          await reader.cancel();
          yield runError(event);
          return;
        }
        if (event.type === 'run:finish' || event.type === 'run:error') {
          // The run is over: close the connection rather than wait for the server's [DONE].
          await reader.cancel();
          yield fromWire(event);
          return;
        }
        yield fromWire(event);
      }
    }
  } finally {
    reader.releaseLock();
  }
  yield runError(ConnectionLost());
}

/**
 * The failure a non-OK response carries. The body is `{ error: envelope }` (what `@arki/http`
 * answers with), revived under {@link RUNTIME_FAILURES}; any other body is `InvalidEnvelope`.
 */
export async function readFailureResponse(response: Response): Promise<RuntimeFailure> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return connectionFailure(error);
  }
  const body = parse(failureBodySchema, text);
  if (isFailure(body)) return InvalidEnvelope({ reason: 'malformed' }, { cause: body });
  return revive(body.error, RUNTIME_FAILURES) ?? InvalidEnvelope({ reason: 'malformed' });
}

/**
 * Client convenience: fetch a runtime endpoint and stream its RuntimeEvents. Pass `init.signal` to
 * cancel: the request and the body read stop, and the stream ends with `Cancelled`. A failed
 * request ends with `ConnectionLost`; a non-OK response with the failure its body carries.
 */
export async function* fetchRuntimeEventStream(
  input: string | URL | Request,
  init?: RequestInit,
): AsyncIterable<RuntimeEvent> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    yield runError(connectionFailure(error, init?.signal));
    return;
  }
  if (!response.ok) {
    yield runError(await readFailureResponse(response));
    return;
  }
  yield* readRuntimeEventStream(response, init?.signal);
}
