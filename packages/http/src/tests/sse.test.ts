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

  it('validates query and delivers params to the generator', async () => {
    const watch = route.sse('/orders/:id/watch', {
      id: 'orders.watch',
      query: z.object({ from: z.coerce.number() }),
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
});
