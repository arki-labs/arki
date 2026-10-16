/**
 * `liveEndpoint` through its fetch handler, with a fake source.
 *
 * Why these tests exist: the stream is the one public door to table activity.
 * Every refusal must happen before a stream header (a 200 SSE response that
 * then errors looks like a working stream to proxies and clients); a client
 * must see only the tables its grant allows, and must not learn that a hidden
 * table is being written, not even through the txids of a frame it never
 * gets; and an old authorization must not keep a stream alive past
 * `maxAgeMs`, nor a gone client keep its hub subscription.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { LiveGrant } from './http.js';
import type { LiveEvent, LiveHub, LiveManifest, TableTag } from './index.js';
import type { SseReader } from './tests/sse-reader.js';
import { liveEndpoint } from './http.js';
import { createLiveHub, LIVE_ERROR_CODES } from './index.js';
import { tableTagSchema } from './schema.js';
import { fakeSource } from './testing.js';
import { sseReader } from './tests/sse-reader.js';

const tag = (table: string): TableTag => ({ schema: 'public', table });
const POSTS = tag('posts');
const USERS = tag('users');
const SECRETS = tag('secrets');
/** Has a trigger (it is written), but no procedure declares it. */
const AUDIT = tag('audit');

const manifest: LiveManifest = [
  { path: ['posts', 'list'], reads: [POSTS, USERS] },
  { path: ['posts', 'count'], reads: [POSTS] },
  { path: ['secrets', 'list'], reads: [SECRETS] },
];

const grantSchema = z.object({ tables: z.array(tableTagSchema).optional() });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A ready hub, its source and an endpoint whose grant comes from the `x-grant` header (JSON), `null` without it. */
async function rig(options: { readonly maxAgeMs?: number } = {}) {
  const source = fakeSource();
  const hub: LiveHub = createLiveHub({ source, limits: { batchMs: 1 } });
  await hub.start();
  source.emit({ kind: 'ready' });
  cleanups.push(() => hub.stop());
  const authorize = vi.fn((request: Request): Promise<LiveGrant | null> => {
    const grant = request.headers.get('x-grant');
    return Promise.resolve(grant === null ? null : grantSchema.parse(JSON.parse(grant)));
  });
  const endpoint = liveEndpoint({ hub, manifest, authorize, ...options });
  const request = (query = '', grant: LiveGrant | null = {}, signal?: AbortSignal) =>
    endpoint.fetch(
      new Request(`http://live.test/api/live${query}`, {
        headers: grant === null ? {} : { 'x-grant': JSON.stringify(grant) },
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  const stream = async (query = '', grant: LiveGrant = {}, signal?: AbortSignal): Promise<SseReader> => {
    const response = await request(query, grant, signal);
    expect(response.status).toBe(200);
    const reader = sseReader(response);
    cleanups.push(() => reader.cancel());
    return reader;
  };
  /** Delivers one commit's hint and waits past the batch window. */
  const commit = async (tags: readonly TableTag[], txid: string): Promise<void> => {
    source.emit({ kind: 'change', tags, txid });
    await sleep(5);
  };
  return { source, hub, authorize, endpoint, request, stream, commit };
}

async function errorOf(
  response: Response,
): Promise<{ readonly status: number; readonly code: unknown; readonly type: string | null }> {
  const body: unknown = await response.json();
  const code = typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
  return {
    status: response.status,
    code: typeof code === 'object' && code !== null && 'code' in code ? code.code : undefined,
    type: response.headers.get('content-type'),
  };
}

describe('refusals happen before any stream header', () => {
  it('a malformed or repeated cursor answers 400 E004, before authorize runs', async () => {
    const { request, authorize, hub } = await rig();
    for (const query of ['?cursor=nope', '?cursor=', '?cursor=abcdefghijkl.1&cursor=abcdefghijkl.2']) {
      expect(await errorOf(await request(query))).toEqual({
        status: 400,
        code: LIVE_ERROR_CODES.protocol,
        type: 'application/json',
      });
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(hub.connections()).toBe(0);
  });

  it('authorize returning null answers 401 E005 and attaches nothing', async () => {
    const { request, hub } = await rig();
    expect(await errorOf(await request('', null))).toEqual({
      status: 401,
      code: LIVE_ERROR_CODES.auth,
      type: 'application/json',
    });
    expect(hub.connections()).toBe(0);
  });

  it('a hub that lost its listener answers 503 E003 with retry-after', async () => {
    const { request, source } = await rig();
    source.emit({ kind: 'gap' });
    const response = await request();
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await errorOf(response)).toEqual({ status: 503, code: LIVE_ERROR_CODES.source, type: 'application/json' });
  });

  it('refuses a bad maxAgeMs with E001', async () => {
    const { hub } = await rig();
    expect(() => liveEndpoint({ hub, manifest, authorize: () => Promise.resolve({}), maxAgeMs: 0 })).toThrow(
      expect.objectContaining({ code: LIVE_ERROR_CODES.config }),
    );
  });
});

describe('the grant filter', () => {
  it('with no tables listed, hello has the whole manifest and only declared tables reach the client', async () => {
    const { stream, commit, request } = await rig();
    const response = await request();
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    await response.body?.cancel();

    const client = await stream();
    expect(await client.next()).toMatchObject({ kind: 'hello', v: 1, mode: 'reset', manifest });
    await commit([AUDIT], '4');
    await commit([AUDIT, SECRETS], '5');
    const change = await client.next();
    expect(change).toMatchObject({ kind: 'change', tags: [SECRETS], txids: ['5'] });
  });

  it('keeps only granted tables, and skips a frame with none of them, txids included', async () => {
    const { stream, commit } = await rig();
    const client = await stream('', { tables: [POSTS, AUDIT] });
    const hello = await client.next();
    // posts.list also reads users, which is not granted; an undeclared table grants nothing.
    expect(hello).toMatchObject({ kind: 'hello', manifest: [{ path: ['posts', 'count'], reads: [POSTS] }] });
    await commit([SECRETS], '41');
    await commit([USERS, AUDIT], '42');
    await commit([SECRETS, POSTS], '43');
    const change = await client.next();
    // Frames 1 and 2 never arrive: not their tags, not their txids, so not even that they existed.
    expect(change).toEqual({ kind: 'change', cursor: expect.stringMatching(/\.3$/), tags: [POSTS], txids: ['43'] });
  });

  it('a transaction that wrote only hidden tables never shows its txid, even on a visible frame of its batch', async () => {
    const { stream, source } = await rig();
    const client = await stream('', { tables: [POSTS] });
    await client.next();
    // One batch window: 41 writes a hidden table, 42 a granted one, 43 both.
    source.emit({ kind: 'change', tags: [SECRETS], txid: '41' });
    source.emit({ kind: 'change', tags: [POSTS], txid: '42' });
    source.emit({ kind: 'change', tags: [SECRETS, POSTS], txid: '43' });
    expect(await client.next()).toMatchObject({ kind: 'change', tags: [POSTS], txids: ['42', '43'] });
  });

  it('a batch over 256 tables whose last frame is hidden still gives the visible frame the txids of its own tables', async () => {
    const { stream, source } = await rig();
    const client = await stream('', { tables: [POSTS] });
    await client.next();
    source.emit({ kind: 'change', tags: [POSTS], txid: '7' });
    // 299 more tables, none granted: the batch splits into two frames, the second all hidden.
    source.emit({ kind: 'change', tags: Array.from({ length: 299 }, (_, index) => tag(`hidden_${index}`)), txid: '8' });
    expect(await client.next()).toEqual({
      kind: 'change',
      cursor: expect.stringMatching(/\.1$/),
      tags: [POSTS],
      txids: ['7'],
    });
  });

  it('a resume replays only the frames the grant shows', async () => {
    const { stream, commit } = await rig();
    const first = await stream('', { tables: [POSTS] });
    const hello = await first.next();
    if (hello?.kind !== 'hello') throw new Error('expected hello');
    await commit([SECRETS], '1');
    await commit([POSTS], '2');
    const again = await stream(`?cursor=${hello.cursor}`, { tables: [POSTS] });
    const frames: (LiveEvent | undefined)[] = [await again.next(), await again.next()];
    expect(frames).toEqual([
      expect.objectContaining({ kind: 'hello', mode: 'resume', cursor: hello.cursor }),
      expect.objectContaining({ kind: 'change', tags: [POSTS], txids: ['2'] }),
    ]);
  });
});

describe('closing', () => {
  it('after maxAgeMs the stream sends bye, ends, and detaches from the hub', async () => {
    const { stream, hub } = await rig({ maxAgeMs: 40 });
    const client = await stream();
    expect(await client.next()).toMatchObject({ kind: 'hello' });
    expect(hub.connections()).toBe(1);
    expect(await client.next()).toEqual({ kind: 'bye' });
    expect(await client.next()).toBeUndefined();
    expect(hub.connections()).toBe(0);
  });

  it('a client that goes away detaches from the hub at once', async () => {
    const { stream, hub } = await rig();
    const abort = new AbortController();
    const client = await stream('', {}, abort.signal);
    expect(await client.next()).toMatchObject({ kind: 'hello' });
    expect(hub.connections()).toBe(1);
    abort.abort();
    expect(hub.connections()).toBe(0);
  });

  it('a listener gap reaches the stream as gap, then the stream ends', async () => {
    const { stream, source } = await rig();
    const client = await stream();
    await client.next();
    source.emit({ kind: 'gap' });
    expect(await client.next()).toEqual({ kind: 'gap' });
    expect(await client.next()).toBeUndefined();
  });
});
