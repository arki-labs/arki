/**
 * Each live stream is one `live.stream` span on the server and one `live.client.connection` span
 * per connection on the client, never one per frame, with no Dot app. The span says why the stream
 * ended, so an operator can tell a client that left from a hub that lost Postgres. It never carries
 * a cursor, a table or a grant: the stream is the door to table activity.
 * The real hub, endpoint and client run in process; the hint source is `fakeSource` from `./testing`.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { SpanStatusCode } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';

import type { CapturedSpan, SpanCapture } from '@arki/testing/otel';
import { captureSpans } from '@arki/testing/otel';

import type { LiveEvent, LiveGrant, LiveHub, LiveManifest, LiveStatus, TableTag } from './index.js';
import { createLiveClient } from './client.js';
import { liveEndpoint } from './http.js';
import { createLiveHub, LIVE_ERROR_CODES } from './index.js';
import { fakeSource } from './testing.js';
import { sseReader } from './tests/sse-reader.js';

const POSTS: TableTag = { schema: 'public', table: 'posts_of_user_4711' };
const manifest: LiveManifest = [{ path: ['posts', 'list'], reads: [POSTS] }];
const ALLOWED = new Set([
  'live.stream.mode',
  'live.stream.end',
  'live.client.attempt',
  'live.client.outcome',
  'http.response.status_code',
  'error.type',
]);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function expectNoStreamData(span: CapturedSpan): void {
  for (const [key, value] of Object.entries(span.attributes)) {
    expect(ALLOWED, `attribute ${key}`).toContain(key);
    expect(String(value)).not.toContain('posts_of_user_4711');
  }
}

/** A hub on a fake source, ready unless told otherwise, and an endpoint whose grant is `grant` (null refuses). */
async function rig(options: { readonly ready?: boolean; readonly maxAgeMs?: number; grant?: LiveGrant | null } = {}) {
  const source = fakeSource();
  const hub: LiveHub = createLiveHub({ source, limits: { batchMs: 1 } });
  expect(await hub.start()).toBeUndefined();
  if (options.ready !== false) source.emit({ kind: 'ready' });
  cleanups.push(() => hub.stop());
  const state = { grant: options.grant === undefined ? {} : options.grant };
  const endpoint = liveEndpoint({
    hub,
    manifest,
    authorize: () => Promise.resolve(state.grant),
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
  });
  cleanups.push(() => endpoint.close());
  const fetch: typeof globalThis.fetch = (input, init) =>
    endpoint.fetch(
      new Request(new URL(input instanceof Request ? input.url : String(input), 'http://live.test'), init),
    );
  return { source, hub, endpoint, fetch, state };
}

async function counter(spans: SpanCapture, name: string) {
  const collected = await spans.collectMetrics();
  return collected.find(metric => metric.descriptor.name === name)?.dataPoints ?? [];
}

describe('live.stream (server)', () => {
  it('spans a stream from attach until the client leaves, and the active count goes back to zero', async () => {
    using spans = captureSpans();
    const { endpoint, source } = await rig();
    const reader = sseReader(await endpoint.fetch(new Request('http://live.test/api/live')));
    expect(await reader.next()).toMatchObject({ kind: 'hello', mode: 'reset' });
    source.emit({ kind: 'change', tags: [POSTS], txid: '1' });
    expect(await reader.next()).toMatchObject({ kind: 'change' });
    await reader.cancel();
    await expect.poll(() => spans.finished.filter(span => span.name === 'live.stream').length).toBe(1);

    const stream = spans.named('live.stream');
    expect(stream.attributes).toEqual({ 'live.stream.mode': 'reset', 'live.stream.end': 'disconnected' });
    expect(stream.status.code).toBe(SpanStatusCode.UNSET);
    expectNoStreamData(stream);
    const active = await counter(spans, 'live.streams.active');
    expect(active.map(point => point.value)).toEqual([0]);
    const ended = await counter(spans, 'live.streams');
    expect(ended.map(point => [point.attributes, point.value])).toEqual([[{ end: 'disconnected' }, 1]]);
  });

  it('a hub that lost its listener ends the stream with gap: the span is failed', async () => {
    using spans = captureSpans();
    const { endpoint, source } = await rig();
    const reader = sseReader(await endpoint.fetch(new Request('http://live.test/api/live')));
    expect(await reader.next()).toMatchObject({ kind: 'hello' });
    source.emit({ kind: 'gap' });
    expect(await reader.next()).toMatchObject({ kind: 'gap' });
    expect(await reader.next()).toBeUndefined();
    await expect.poll(() => spans.finished.filter(span => span.name === 'live.stream').length).toBe(1);
    const stream = spans.named('live.stream');
    expect(stream.attributes['live.stream.end']).toBe('gap');
    expect(stream.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('maxAgeMs ends the stream with bye, and the span says max_age', async () => {
    using spans = captureSpans();
    const { endpoint } = await rig({ maxAgeMs: 30 });
    const reader = sseReader(await endpoint.fetch(new Request('http://live.test/api/live')));
    expect(await reader.next()).toMatchObject({ kind: 'hello' });
    expect(await reader.next()).toMatchObject({ kind: 'bye' });
    await expect.poll(() => spans.finished.filter(span => span.name === 'live.stream').length).toBe(1);
    expect(spans.named('live.stream').attributes['live.stream.end']).toBe('max_age');
  });

  it('a hub that is not ready refuses with 503: the span is failed with the stable code, not the message', async () => {
    using spans = captureSpans();
    const { endpoint } = await rig({ ready: false });
    const response = await endpoint.fetch(new Request('http://live.test/api/live'));
    expect(response.status).toBe(503);
    const stream = spans.named('live.stream');
    expect(stream.attributes).toEqual({ 'live.stream.end': 'error', 'error.type': LIVE_ERROR_CODES.source });
    expect(stream.status.code).toBe(SpanStatusCode.ERROR);
    expect(stream.events).toEqual([]);
  });

  it('a refused request never attaches, so it has no stream span', async () => {
    using spans = captureSpans();
    const { endpoint } = await rig({ grant: null });
    const response = await endpoint.fetch(new Request('http://live.test/api/live'));
    expect(response.status).toBe(401);
    expect(spans.finished.filter(span => span.name === 'live.stream')).toEqual([]);
  });
});

describe('live.client.connection (client)', () => {
  it('spans each connection: bye reconnects at once, stop ends the last one, and the count says why', async () => {
    using spans = captureSpans();
    const { fetch } = await rig({ maxAgeMs: 30 });
    const events: LiveEvent[] = [];
    const client = createLiveClient({
      url: '/api/live',
      fetch,
      onEvent: event => {
        events.push(event);
      },
    });
    client.start();
    cleanups.push(() => client.stop());
    // The 30 ms max age sends bye; the client reconnects at once with its cursor.
    await expect.poll(() => events.filter(event => event.kind === 'hello').length, { timeout: 2000 }).toBe(2);
    client.stop();
    await expect
      .poll(() => spans.finished.filter(span => span.name === 'live.client.connection').length, { timeout: 2000 })
      .toBeGreaterThanOrEqual(2);

    const connections = spans.finished.filter(span => span.name === 'live.client.connection');
    expect(connections[0]?.attributes).toEqual({
      'live.client.attempt': 0,
      'http.response.status_code': 200,
      'live.client.outcome': 'bye',
    });
    expect(connections.at(-1)?.attributes['live.client.outcome']).toBe('stopped');
    for (const span of connections) {
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expectNoStreamData(span);
    }
    // The server's stream span joins the client's trace: the in-process fetch runs inside the connection
    // span, `@arki/http` spans the request, and the stream nests under that request.
    const streams = spans.finished.filter(span => span.name === 'live.stream');
    expect(streams.length).toBeGreaterThanOrEqual(1);
    for (const stream of streams) {
      expect(stream.parent?.name).toBe('http.request');
      expect(stream.parent?.parent?.name).toBe('live.client.connection');
    }
  });

  it('a 401 ends the connection as unauthorized, failed, and the client stops retrying', async () => {
    using spans = captureSpans();
    const { fetch } = await rig({ grant: null });
    const statuses: LiveStatus[] = [];
    const client = createLiveClient({
      url: '/api/live',
      fetch,
      onEvent: () => Promise.resolve(),
      onStatus: s => statuses.push(s),
    });
    client.start();
    cleanups.push(() => client.stop());
    await expect.poll(() => statuses.at(-1)).toBe('unauthorized');
    await sleep(20);
    const connection = spans.named('live.client.connection');
    expect(connection.attributes).toEqual({
      'live.client.attempt': 0,
      'http.response.status_code': 401,
      'live.client.outcome': 'unauthorized',
    });
    expect(connection.status.code).toBe(SpanStatusCode.ERROR);
    const counted = await counter(spans, 'live.client.connections');
    expect(counted.map(point => [point.attributes, point.value])).toEqual([[{ outcome: 'unauthorized' }, 1]]);
  });

  it('a gap backs off: the connection is failed with outcome retry', async () => {
    using spans = captureSpans();
    const { fetch, source } = await rig();
    const events: LiveEvent[] = [];
    const client = createLiveClient({ url: '/api/live', fetch, onEvent: event => void events.push(event) });
    client.start();
    cleanups.push(() => client.stop());
    await expect.poll(() => events.length).toBe(1);
    source.emit({ kind: 'gap' });
    await expect
      .poll(() => spans.finished.filter(span => span.name === 'live.client.connection').length)
      .toBeGreaterThanOrEqual(1);
    const connection = spans.finished.find(span => span.name === 'live.client.connection');
    expect(connection?.attributes['live.client.outcome']).toBe('retry');
    expect(connection?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
