import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { z } from 'zod';

import { serialize } from '@arki/failure';

import { RateLimited } from '../failures';
import type { RuntimeWireEvent , runtimeWireEventSchema} from './sse';
import { fetchRuntimeEventStream, readRuntimeEventStream, toRuntimeEventStreamResponse } from './sse';
import type { RuntimeEvent } from './types';
import { RUNTIME_FAILURES } from './types';

async function* fromArray(events: RuntimeEvent[]): AsyncIterable<RuntimeEvent> {
  for (const event of events) yield event;
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
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

  it('emits a terminal run:error frame with a typed failure when the source throws', async () => {
    async function* boom(): AsyncIterable<RuntimeEvent> {
      yield { type: 'run:start' };
      throw new Error('model exploded');
    }
    const decoded = await collect(readRuntimeEventStream(toRuntimeEventStreamResponse(boom())));
    expect(decoded[0]).toEqual({ type: 'run:start' });
    const last = decoded.at(-1);
    expect(last?.type === 'run:error' ? last.failure.code : undefined).toBe('failure.unexpected_defect');
  });

  it('keeps a run:error failure typed across the wire, Retry-After included', async () => {
    // WHY (F14): the wire used to flatten a failure to message text; a client must still see
    // RateLimited and its wait to back off correctly.
    const events: RuntimeEvent[] = [{ type: 'run:start' }, { type: 'run:error', failure: RateLimited({ retryAfterMs: 1500 }) }];
    const decoded = await collect(readRuntimeEventStream(toRuntimeEventStreamResponse(fromArray(events))));
    const last = decoded.at(-1);
    expect(last?.type === 'run:error' && RateLimited.is(last.failure) ? last.failure.data.retryAfterMs : undefined).toBe(1500);
  });

  it('carries a tool failure without a remediation', async () => {
    const events: RuntimeEvent[] = [
      { type: 'tool:failure', tool: 'weather', failure: { code: 'city.not_found', message: 'no city', remediation: undefined, data: {} } },
      { type: 'run:finish', text: '' },
    ];
    const decoded = await collect(readRuntimeEventStream(toRuntimeEventStreamResponse(fromArray(events))));
    expect(decoded[0]).toMatchObject({ type: 'tool:failure', failure: { code: 'city.not_found' } });
  });

  it('ends with an InvalidInput run:error at a malformed frame instead of dropping it', async () => {
    // WHY (F14): a frame that is not JSON, or JSON that is not an event, used to vanish or be cast; the
    // UI must see the stream broke.
    for (const bad of ['{not json', JSON.stringify({ type: 'text:delta', delta: 7 })]) {
      const body = streamOf(`data: ${JSON.stringify({ type: 'run:start' })}\n\ndata: ${bad}\n\ndata: ${JSON.stringify({ type: 'run:finish', text: '' })}\n\n`);
      const decoded = await collect(readRuntimeEventStream(body));
      expect(decoded.map(event => event.type)).toEqual(['run:start', 'run:error']);
      expect(decoded[1]?.type === 'run:error' ? decoded[1].failure.code : undefined).toBe('schema.invalid_input');
    }
  });

  it('ends with ConnectionLost when the body ends before a terminal event', async () => {
    // WHY: a dropped connection must not leave the UI waiting in a `running` state forever.
    const decoded = await collect(readRuntimeEventStream(streamOf(`data: ${JSON.stringify({ type: 'run:start' })}\n\n`)));
    expect(decoded.at(-1)?.type === 'run:error' ? decoded.at(-1) : undefined).toMatchObject({
      failure: { code: 'ai.connection_lost' },
    });
  });

  it('stops reading the source when the client goes away', async () => {
    // WHY (F14): a run nobody reads must stop; the response used to drain the whole source anyway.
    let stopped = false;
    async function* endless(): AsyncIterable<RuntimeEvent> {
      try {
        yield { type: 'run:start' };
        for (;;) yield { type: 'text:delta', delta: 'x' };
      } finally {
        stopped = true;
      }
    }
    const body = toRuntimeEventStreamResponse(endless()).body;
    const reader = body?.getReader();
    await reader?.read();
    await reader?.cancel();
    expect(stopped).toBe(true);
  });

  it('locks the wire schema to the RuntimeEvent type both ways', () => {
    expectTypeOf<z.output<typeof runtimeWireEventSchema>>().toEqualTypeOf<RuntimeWireEvent>();
  });

  it('tolerates events split across chunk boundaries', async () => {
    // Simulate a body that breaks a frame mid-JSON across two reads.
    const encoder = new TextEncoder();
    const full = `data: ${JSON.stringify({ type: 'text:delta', delta: 'hello' })}\n\ndata: ${JSON.stringify({ type: 'run:finish', text: 'hello' })}\n\ndata: [DONE]\n\n`;
    const mid = Math.floor(full.length / 2);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(full.slice(0, mid)));
        controller.enqueue(encoder.encode(full.slice(mid)));
        controller.close();
      },
    });
    const decoded = await collect(readRuntimeEventStream(body));
    expect(decoded).toEqual([
      { type: 'text:delta', delta: 'hello' },
      { type: 'run:finish', text: 'hello' },
    ]);
  });
});

describe('fetchRuntimeEventStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('revives the typed failure of a non-OK response', async () => {
    // WHY (F14): a 429 from the endpoint used to become a status string; its RateLimited body is the answer.
    const body = JSON.stringify({ error: serialize(RateLimited({ retryAfterMs: 900 }), RUNTIME_FAILURES) });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(body, { status: 429 })));
    const decoded = await collect(fetchRuntimeEventStream('https://runtime.test'));
    expect(decoded).toHaveLength(1);
    const first = decoded[0];
    expect(first?.type === 'run:error' && RateLimited.is(first.failure) ? first.failure.data.retryAfterMs : undefined).toBe(900);
  });

  it('reports a non-OK response whose body is not a failure as InvalidEnvelope', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 })));
    const decoded = await collect(fetchRuntimeEventStream('https://runtime.test'));
    expect(decoded[0]?.type === 'run:error' ? decoded[0].failure.code : undefined).toBe('failure.invalid_envelope');
  });

  it('reports a request that never connected as ConnectionLost', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const decoded = await collect(fetchRuntimeEventStream('https://runtime.test'));
    expect(decoded[0]?.type === 'run:error' ? decoded[0].failure.code : undefined).toBe('ai.connection_lost');
  });
});
