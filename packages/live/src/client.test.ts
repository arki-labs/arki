/**
 * `createLiveClient` (plan M3.1): the SSE framing a browser or React Native
 * client reads, and what each way a connection ends leads to. Scripted
 * `fetch`, fake timers: every wait is exact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveEvent, LiveStatus } from './index.js';
import { createLiveClient } from './index.js';

const CURSOR_A = `${'a'.repeat(63)}A`;
const CURSOR_B = `${'b'.repeat(63)}B`;
const hello = (cursor = CURSOR_A, mode: 'reset' | 'resume' = 'reset'): Extract<LiveEvent, { kind: 'hello' }> => ({
  kind: 'hello',
  v: 1,
  mode,
  cursor,
  manifest: [],
});
const change = (cursor = CURSOR_B): LiveEvent => ({
  kind: 'change',
  cursor,
  tags: [{ schema: 'public', table: 'posts' }],
  txids: ['7'],
});
const frame = (event: LiveEvent): string => `data: ${JSON.stringify(event)}\n\n`;

/** A body that sends `chunks` (strings are UTF-8 encoded), then stays open unless `end`. */
function body(chunks: readonly (string | Uint8Array)[], end = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      if (end) controller.close();
    },
  });
}

const sse = (stream: ReadableStream<Uint8Array>): Response =>
  new Response(stream, { headers: { 'content-type': 'text/event-stream' } });

/** A `fetch` that answers each request with the next response; once they run out, a stream that never sends. */
function scriptedFetch(responses: (() => Response)[]) {
  const urls: string[] = [];
  const fetch = vi.fn((input: RequestInfo | URL): Promise<Response> => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const next = responses.shift();
    return Promise.resolve(next ? next() : sse(body([])));
  });
  return { fetch, urls };
}

function client(fetch: typeof globalThis.fetch, cursor?: string) {
  const events: LiveEvent[] = [];
  const statuses: LiveStatus[] = [];
  const live = createLiveClient({
    url: '/api/live',
    fetch,
    ...(cursor === undefined ? {} : { cursor }),
    onEvent: event => {
      events.push(event);
    },
    onStatus: status => statuses.push(status),
  });
  live.start();
  return { live, events, statuses };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('framing', () => {
  it('reads frames split anywhere, a UTF-8 code point split across chunks, CRLF lines and keepalive comments', async () => {
    // Why: proxies and React Native re-chunk freely; a frame or a character cut in two must
    // still arrive whole, and the heartbeat must never reach the app as a frame.
    const text = frame({
      ...hello(),
      manifest: [{ path: ['posts', 'listeé'], reads: [{ schema: 'public', table: 'posts' }] }],
    });
    const bytes = new TextEncoder().encode(text);
    const cut = text.indexOf('é') + 1; // inside the two bytes of "é"
    // One frame in two data lines, cut right after a line's \r: the \n that follows must not end the frame.
    const json = JSON.stringify(change());
    const at = json.indexOf(',"cursor"') + 1; // between two members: a newline there is still JSON
    const [open, rest] = [json.slice(0, at), json.slice(at)];
    const crlf = `data: ${open}\r\ndata: ${rest}\r\n\r\n`;
    const cr = crlf.indexOf('\r') + 1;
    const { fetch } = scriptedFetch([
      () =>
        sse(
          body([
            ':keepalive\n\n',
            bytes.slice(0, 5),
            bytes.slice(5, cut),
            bytes.slice(cut),
            crlf.slice(0, cr),
            crlf.slice(cr),
          ]),
        ),
    ]);
    const { events, statuses } = client(fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([
      { ...hello(), manifest: [{ path: ['posts', 'listeé'], reads: [{ schema: 'public', table: 'posts' }] }] },
      change(),
    ]);
    expect(statuses).toEqual(['connecting', 'live']);
  });

  it('an error frame or a malformed frame reconnects after a backoff, with the last good cursor', async () => {
    const { fetch, urls } = scriptedFetch([
      () => sse(body([frame(hello()), 'event: error\ndata: {"code":"X"}\n\n'])),
      () => sse(body([frame(hello(CURSOR_A, 'resume')), 'data: {"kind":"change"}\n\n'])),
    ]);
    const { events } = client(fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400); // first retry: 250 ms ± 25%
    expect(urls[1]).toBe(`/api/live?cursor=${CURSOR_A}`);
    expect(events.map(event => event.kind)).toEqual(['hello', 'hello']);
    await vi.advanceTimersByTimeAsync(800); // second retry: 500 ms ± 25%
    expect(urls).toHaveLength(3);
  });
});

describe('reconnecting', () => {
  it('bye reconnects at once with the cursor of the last frame handled', async () => {
    const { fetch, urls } = scriptedFetch([
      () => sse(body([frame(hello()), frame(change()), frame({ kind: 'bye' })], true)),
    ]);
    const { statuses } = client(fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(urls).toEqual(['/api/live', `/api/live?cursor=${CURSOR_B}`]);
    expect(statuses).toEqual(['connecting', 'live', 'reconnecting']);
  });

  it('gap and a dropped connection back off, then reconnect with the cursor', async () => {
    const { fetch, urls } = scriptedFetch([
      () => sse(body([frame(hello()), frame({ kind: 'gap' })])),
      () => sse(body([frame(hello(CURSOR_B))], true)),
    ]);
    client(fetch);
    await vi.advanceTimersByTimeAsync(180);
    expect(urls).toHaveLength(1); // no retry before 75% of 250 ms
    await vi.advanceTimersByTimeAsync(150);
    expect(urls).toEqual(['/api/live', `/api/live?cursor=${CURSOR_A}`]);
    // The second stream ended without bye: a backoff again, which the hello reset to the first step.
    await vi.advanceTimersByTimeAsync(330);
    expect(urls[2]).toBe(`/api/live?cursor=${CURSOR_B}`);
  });

  it('a 503 waits at least its retry-after', async () => {
    const { fetch, urls } = scriptedFetch([
      () => new Response(null, { status: 503, headers: { 'retry-after': '2' } }),
      () => sse(body([frame(hello())])),
    ]);
    const { statuses } = client(fetch);
    await vi.advanceTimersByTimeAsync(1999);
    expect(urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(urls).toHaveLength(2);
    expect(statuses).toEqual(['connecting', 'reconnecting', 'live']);
  });

  it('401 and 403 stop the client: unauthorized, no retry', async () => {
    for (const status of [401, 403]) {
      const { fetch, urls } = scriptedFetch([() => new Response(null, { status })]);
      const { statuses } = client(fetch);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(urls).toHaveLength(1);
      expect(statuses).toEqual(['connecting', 'unauthorized']);
    }
  });

  it('a 400 drops the cursor it was given, then connects without one', async () => {
    const { fetch, urls } = scriptedFetch([() => new Response(null, { status: 400 })]);
    client(fetch, CURSOR_A);
    await vi.advanceTimersByTimeAsync(400);
    expect(urls).toEqual([`/api/live?cursor=${CURSOR_A}`, '/api/live']);
  });

  it('the network coming back ends a backoff wait at once', async () => {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    try {
      const { fetch, urls } = scriptedFetch([
        () => new Response(null, { status: 500 }),
        () => new Response(null, { status: 500 }),
      ]);
      client(fetch);
      await vi.advanceTimersByTimeAsync(0);
      target.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
      expect(urls).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a connection that goes silent (no byte, no close) is dropped after 35 s and resumed with its cursor', async () => {
    // Why: a half-open connection (network gone, no FIN or RST) would otherwise stay `live` forever
    // and miss every write. The server sends a keepalive every 15 s; two missed ones mean it is dead.
    const encoder = new TextEncoder();
    let push: ((text: string) => void) | undefined;
    const open = new ReadableStream<Uint8Array>({
      start(controller) {
        push = text => controller.enqueue(encoder.encode(text));
      },
    });
    const { fetch, urls } = scriptedFetch([() => sse(open)]);
    const { statuses } = client(fetch);
    await vi.advanceTimersByTimeAsync(0);
    push?.(frame(hello()));
    await vi.advanceTimersByTimeAsync(34_000);
    push?.(':keepalive\n\n');
    await vi.advanceTimersByTimeAsync(34_000);
    // Keepalives keep it open.
    expect(urls).toHaveLength(1);
    expect(statuses.at(-1)).toBe('live');
    await vi.advanceTimersByTimeAsync(1001);
    expect(statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(400);
    expect(urls).toEqual(['/api/live', `/api/live?cursor=${CURSOR_A}`]);
  });

  it('the browser going offline drops the stream at once; coming back online reconnects at once', async () => {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    try {
      const { fetch, urls } = scriptedFetch([() => sse(body([frame(hello())]))]);
      const { statuses } = client(fetch);
      await vi.advanceTimersByTimeAsync(0);
      expect(statuses.at(-1)).toBe('live');
      target.dispatchEvent(new Event('offline'));
      await vi.advanceTimersByTimeAsync(0);
      expect(statuses.at(-1)).toBe('reconnecting');
      expect(urls).toHaveLength(1);
      target.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
      expect(urls).toEqual(['/api/live', `/api/live?cursor=${CURSOR_A}`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stop aborts the stream and ends every retry', async () => {
    const { fetch, urls } = scriptedFetch([() => new Response(null, { status: 500 })]);
    const { live, statuses } = client(fetch);
    await vi.advanceTimersByTimeAsync(0);
    live.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(urls).toHaveLength(1);
    expect(live.status()).toBe('closed');
    expect(statuses.at(-1)).toBe('closed');
  });

  it('a fetch without a streaming body fails loud and stops (React Native without a streaming fetch)', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const { live } = client(fetch);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(live.status()).toBe('closed');
  });
});
