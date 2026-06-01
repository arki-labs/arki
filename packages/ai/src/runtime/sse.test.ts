import { describe, expect, it } from 'vitest';

import { readRuntimeEventStream, toRuntimeEventStreamResponse } from './sse';
import type { RuntimeEvent } from './types';

async function* fromArray(events: RuntimeEvent[]): AsyncIterable<RuntimeEvent> {
  for (const event of events) yield event;
}

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('SSE runtime transport', () => {
  it('round-trips a RuntimeEvent stream server→SSE→client losslessly', async () => {
    // WHY: this is the wire between runToolLoop (server) and useRuntimeStream (client). If
    // framing or JSON encoding drifts, the UI silently loses events. Round-trip locks it.
    const events: RuntimeEvent[] = [
      { type: 'run:start' },
      { type: 'tool:start', tool: 'analyze_distinctiveness', args: { reason: 'has competitors' } },
      { type: 'tool:result', tool: 'analyze_distinctiveness', result: { claims: ['close to Lunar'] } },
      { type: 'text:delta', delta: 'Lumora is ' },
      { type: 'text:delta', delta: 'distinctive.' },
      { type: 'run:finish', text: 'Lumora is distinctive.', usage: { totalTokens: 21 } },
    ];

    const response = toRuntimeEventStreamResponse(fromArray(events));
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const decoded = await collect(readRuntimeEventStream(response));
    expect(decoded).toEqual(events);
  });

  it('emits a terminal run:error frame when the source throws', async () => {
    async function* boom(): AsyncIterable<RuntimeEvent> {
      yield { type: 'run:start' };
      throw new Error('model exploded');
    }
    const decoded = await collect(readRuntimeEventStream(toRuntimeEventStreamResponse(boom())));
    expect(decoded[0]).toEqual({ type: 'run:start' });
    expect(decoded.at(-1)).toEqual({ type: 'run:error', error: 'model exploded' });
  });

  it('tolerates events split across chunk boundaries', async () => {
    // Simulate a body that breaks a frame mid-JSON across two reads.
    const encoder = new TextEncoder();
    const full = `data: ${JSON.stringify({ type: 'text:delta', delta: 'hello' })}\n\ndata: [DONE]\n\n`;
    const mid = Math.floor(full.length / 2);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(full.slice(0, mid)));
        controller.enqueue(encoder.encode(full.slice(mid)));
        controller.close();
      },
    });
    const decoded = await collect(readRuntimeEventStream(body));
    expect(decoded).toEqual([{ type: 'text:delta', delta: 'hello' }]);
  });
});
