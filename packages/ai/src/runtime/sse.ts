import { debugRuntime } from '../debug';
import type { RuntimeEvent } from './types';

/**
 * SSE transport for the agent-runtime adapter (P2 completion). Completes the wire:
 *
 *   server:  runToolLoop(input)  ──toRuntimeEventStreamResponse──▶  text/event-stream
 *   client:  readRuntimeEventStream(response)  ──▶  AsyncIterable<RuntimeEvent>  ──▶  useRuntimeStream
 *
 * Web-standard (`Response` / `ReadableStream` / `TextEncoder`), so it runs on Bun, Node 18+,
 * edge runtimes, and the browser. `RuntimeEvent`s are JSON-serialized one per SSE `data:` frame,
 * terminated by a `[DONE]` sentinel.
 */
const DONE = '[DONE]';

/** Server: serialize a RuntimeEvent stream as an SSE `Response`. */
export function toRuntimeEventStreamResponse(
  events: AsyncIterable<RuntimeEvent>,
  init?: ResponseInit,
): Response {
  const encoder = new TextEncoder();
  const frame = (event: RuntimeEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(frame(event));
        }
      } catch (error) {
        // Surface a stream-level failure as a terminal run:error frame rather than a dropped stream.
        controller.enqueue(frame({ type: 'run:error', error: error instanceof Error ? error.message : String(error) }));
      } finally {
        controller.enqueue(encoder.encode(`data: ${DONE}\n\n`));
        controller.close();
      }
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

/** Client: decode an SSE `Response` (or raw body stream) back into RuntimeEvents. */
export async function* readRuntimeEventStream(
  input: Response | ReadableStream<Uint8Array>,
): AsyncIterable<RuntimeEvent> {
  const body = input instanceof Response ? input.body : input;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const dataLine = rawFrame.startsWith('data:') ? rawFrame.slice(5).trim() : rawFrame.trim();
        if (dataLine.length === 0 || dataLine === DONE) continue;
        try {
          yield JSON.parse(dataLine) as RuntimeEvent;
        } catch {
          debugRuntime('readRuntimeEventStream: skipping malformed SSE frame');
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Client convenience: fetch a runtime endpoint and stream its RuntimeEvents. */
export async function* fetchRuntimeEventStream(
  input: string | URL | Request,
  init?: RequestInit,
): AsyncIterable<RuntimeEvent> {
  const response = await fetch(input, init);
  if (!response.ok) {
    yield { type: 'run:error', error: `runtime endpoint ${response.status} ${response.statusText}` };
    return;
  }
  yield* readRuntimeEventStream(response);
}
