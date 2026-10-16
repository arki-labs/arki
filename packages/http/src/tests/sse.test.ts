/**
 * SSE streaming through the engine: framing, schema enforcement on
 * yielded events, terminal error frames, and disconnect-driven generator
 * cleanup.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { routes } from '../bundle.js';
import { route } from '../contract.js';
import { buildEngine } from '../engine.js';
import { HTTP_ERROR_CODES } from '../error.js';
import { codec } from '../wire.js';

const BASE = 'http://test.local';

async function readAll(res: Response): Promise<string> {
  return await res.text();
}

describe('sse bindings', () => {
  it('frames yielded events as data: messages with the stream content type', async () => {
    const progress = route.sse('/progress', {
      id: 'progress',
      event: z.object({ step: z.number() }),
    });
    const engine = buildEngine([
      routes().bind(progress, async function* () {
        yield { step: 1 };
        yield { step: 2 };
      }),
    ]);

    const res = await engine.fetch(new Request(`${BASE}/progress`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await readAll(res)).toBe('data: {"step":1}\n\ndata: {"step":2}\n\n');
  });

  it('encodes each event, so a codec frames a Date as its ISO string', async () => {
    // Decoding the Date would fail the string input and the stream would
    // end in an error frame instead of the event.
    const ticks = route.sse('/ticks', {
      id: 'ticks',
      event: codec(
        z.object({ at: z.iso.datetime().transform(text => new Date(text)) }),
        z.object({ at: z.date().transform(date => date.toISOString()) }),
      ),
    });
    const engine = buildEngine([
      routes().bind(ticks, async function* () {
        yield { at: new Date(0) };
      }),
    ]);

    const res = await engine.fetch(new Request(`${BASE}/ticks`));
    expect(await readAll(res)).toBe('data: {"at":"1970-01-01T00:00:00.000Z"}\n\n');
  });

  it('validates query and delivers params to the generator', async () => {
    const watch = route.sse('/orders/:id/watch', {
      id: 'orders.watch',
      query: { from: z.coerce.number() },
      event: z.object({ id: z.string(), from: z.number() }),
    });
    const engine = buildEngine([
      routes().bind(watch, async function* ({ params, query }) {
        yield { id: params.id, from: query.from };
      }),
    ]);

    const res = await engine.fetch(new Request(`${BASE}/orders/o1/watch?from=3`));
    expect(await readAll(res)).toBe('data: {"id":"o1","from":3}\n\n');

    const bad = await engine.fetch(new Request(`${BASE}/orders/o1/watch?from=abc`));
    expect(bad.status).toBe(400);
  });

  it('emits a terminal error frame when a yielded event violates the schema', async () => {
    const strict = route.sse('/strict', { id: 'strict', event: z.object({ n: z.number() }) });
    const engine = buildEngine([
      routes().bind(strict, async function* () {
        yield { n: 1 };
        yield { n: 'two' } as unknown as { n: number }; // runtime contract violation
        yield { n: 3 };
      }),
    ]);

    const body = await readAll(await engine.fetch(new Request(`${BASE}/strict`)));
    expect(body).toContain('data: {"n":1}\n\n');
    expect(body).toContain('event: error\n');
    expect(body).toContain(HTTP_ERROR_CODES.internal);
    expect(body).not.toContain('{"n":3}');
  });

  it('terminates the generator (finally runs) when the client disconnects', async () => {
    let cleaned = false;
    const feed = route.sse('/feed', { id: 'feed', event: z.object({ tick: z.number() }) });
    const engine = buildEngine([
      routes().bind(feed, async function* (_input, ctx) {
        try {
          yield { tick: 1 };
          await new Promise<void>(resolve => {
            ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          yield { tick: 2 };
        } finally {
          cleaned = true;
        }
      }),
    ]);

    const controller = new AbortController();
    const res = await engine.fetch(new Request(`${BASE}/feed`, { signal: controller.signal }));
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: {"tick":1}\n\n');

    controller.abort();
    await reader.cancel().catch(() => {
      // A post-abort cancel may reject depending on runtime; the assertion
      // below is the contract under test.
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(cleaned).toBe(true);
  });

  // Browsers, Deno's web API and Hermes return a number from setInterval, not a
  // Node timer object. The heartbeat must work there too, or every SSE route
  // with `heartbeatMs` fails to open outside Node and Bun.
  it('sends heartbeats where setInterval returns a number (browser, Deno, Hermes)', async () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const running = new Map<number, ReturnType<typeof realSetInterval>>();
    let nextId = 0;
    Object.defineProperty(globalThis, 'setInterval', {
      configurable: true,
      value: (callback: () => void, ms: number): number => {
        nextId += 1;
        running.set(nextId, realSetInterval(callback, ms));
        return nextId;
      },
    });
    Object.defineProperty(globalThis, 'clearInterval', {
      configurable: true,
      value: (id: number): void => {
        realClearInterval(running.get(id));
        running.delete(id);
      },
    });

    try {
      const feed = route.sse('/beats', { id: 'beats', event: z.object({ n: z.number() }), heartbeatMs: 5 });
      const engine = buildEngine([
        routes().bind(feed, async function* () {
          await new Promise(resolve => setTimeout(resolve, 40));
          yield { n: 1 };
        }),
      ]);

      const res = await engine.fetch(new Request(`${BASE}/beats`));
      const text = await readAll(res);

      expect(text).toContain(':keepalive\n\n');
      expect(text.endsWith('data: {"n":1}\n\n')).toBe(true);
      expect(running.size).toBe(0);
    } finally {
      Object.defineProperty(globalThis, 'setInterval', { configurable: true, writable: true, value: realSetInterval });
      Object.defineProperty(globalThis, 'clearInterval', { configurable: true, writable: true, value: realClearInterval });
    }
  });
});
