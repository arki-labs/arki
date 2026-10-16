/**
 * `idempotent()` runs a mutating request once per key. These tests use an in-memory
 * `ResponseCache` double, so they show the middleware's rules and not a store's.
 * The test double lives here, not in the public API: each real store (Postgres, Redis)
 * has its own cache, and a map-backed one would hide the atomicity they must provide.
 */
import { describe, expect, it } from 'vitest';

import type { BeginResult, ResponseCache, StoredResponse } from '../idempotency.js';
import { composeMiddleware } from '../engine.js';
import { idempotent } from '../idempotency.js';

type Entry = { fingerprint: string; owner: string; expiresAt: number; response?: StoredResponse };

function memoryCache(now: () => number = Date.now): ResponseCache & { readonly entries: Map<string, Entry> } {
  const entries = new Map<string, Entry>();
  return {
    entries,
    begin: (key, fingerprint, owner, ttl): Promise<BeginResult> => {
      const held = entries.get(key);
      if (held === undefined || held.expiresAt <= now()) {
        entries.set(key, { fingerprint, owner, expiresAt: now() + ttl });
        return Promise.resolve('started');
      }
      if (held.fingerprint !== fingerprint) return Promise.resolve('conflict');
      return Promise.resolve(held.response === undefined ? 'in-progress' : { replay: held.response });
    },
    finish: (key, owner, response) => {
      const held = entries.get(key);
      if (held?.owner === owner) held.response = response;
      return Promise.resolve();
    },
    abandon: (key, owner) => {
      if (entries.get(key)?.owner === owner) entries.delete(key);
      return Promise.resolve();
    },
  };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

function setup(
  handler: (req: Request, calls: number) => Response | Promise<Response>,
  overrides: Partial<Parameters<typeof idempotent>[0]> = {},
) {
  const cache = memoryCache();
  let calls = 0;
  const fetch = composeMiddleware(
    async req => {
      calls += 1;
      return await handler(req, calls);
    },
    [
      idempotent({
        cache,
        scope: req => req.headers.get('x-user') ?? undefined,
        routes: ['POST /orders', 'POST /orders/:id/pay'],
        ttl: 60_000,
        ...overrides,
      }),
    ],
  );
  return { cache, fetch, calls: () => calls };
}

const created = (_req: Request, calls: number) =>
  Response.json(
    { order: calls },
    {
      status: 201,
      headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', location: '/orders/1' },
    },
  );

const keyed = { 'idempotency-key': 'k1', 'x-user': 'u1' };

/** A keyed POST whose body streams in 40-byte chunks with no content-length, like a chunked upload. */
const chunkedPost = (bytes: number) => {
  const chunk = new TextEncoder().encode('z'.repeat(40));
  return new Request('http://x/orders', {
    method: 'POST',
    headers: keyed,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sent = 0; sent < bytes; sent += chunk.byteLength) controller.enqueue(chunk);
        controller.close();
      },
    }),
    duplex: 'half',
  });
};

describe('idempotent', () => {
  it('replays the stored body and only the allowlisted headers, without running the handler again', async () => {
    const { fetch, calls } = setup(created);
    const first = await fetch(post('/orders', { sku: 1 }, keyed));
    const second = await fetch(post('/orders', { sku: 1 }, keyed));
    expect(calls()).toBe(1);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.headers.get('location')).toBe('/orders/1');
    expect(second.headers.get('set-cookie')).toBeNull();
    expect(first.headers.get('idempotent-replayed')).toBeNull();
  });

  it('refuses the same key with a different body, so a client bug cannot get another request answered', async () => {
    const { fetch, calls } = setup(created);
    await fetch(post('/orders', { sku: 1 }, keyed));
    const res = await fetch(post('/orders', { sku: 2 }, keyed));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: 'ARKI_HTTP_E411' } });
    expect(calls()).toBe(1);
  });

  it('answers 409 with retry-after while the first request still runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { fetch, calls } = setup(async req => {
      await gate;
      return created(req, 1);
    });
    const first = fetch(post('/orders', { sku: 1 }, keyed));
    await new Promise(resolve => setTimeout(resolve, 10));
    const busy = await fetch(post('/orders', { sku: 1 }, keyed));
    expect(busy.status).toBe(409);
    expect(busy.headers.get('retry-after')).toBe('1');
    release();
    await first;
    const replay = await fetch(post('/orders', { sku: 1 }, keyed));
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(calls()).toBe(1);
  });

  it('never replays for an unauthenticated request, and does not ask for a key', async () => {
    const { fetch, calls } = setup(created);
    const anonymous = { 'idempotency-key': 'k1' };
    await fetch(post('/orders', { sku: 1 }, anonymous));
    const second = await fetch(post('/orders', { sku: 1 }, anonymous));
    expect(calls()).toBe(2);
    expect(second.headers.get('idempotent-replayed')).toBeNull();
    const noKey = await fetch(post('/orders', { sku: 1 }));
    expect(noKey.status).toBe(201);
  });

  it('keeps two callers with the same key apart', async () => {
    const { fetch, calls } = setup(created);
    await fetch(post('/orders', { sku: 1 }, keyed));
    const other = await fetch(post('/orders', { sku: 1 }, { ...keyed, 'x-user': 'u2' }));
    expect(other.headers.get('idempotent-replayed')).toBeNull();
    expect(calls()).toBe(2);
  });

  it('answers 400 when a listed route has no key, and leaves unlisted routes and methods alone', async () => {
    const { fetch, calls } = setup(created);
    const missing = await fetch(post('/orders', { sku: 1 }, { 'x-user': 'u1' }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: 'ARKI_HTTP_E410' } });
    expect(calls()).toBe(0);
    const unlisted = await fetch(post('/other', {}, { 'x-user': 'u1' }));
    const otherMethod = await fetch(new Request('http://x/orders', { headers: { 'x-user': 'u1' } }));
    expect([unlisted.status, otherMethod.status]).toEqual([201, 201]);
  });

  it('matches path parameters on listed routes', async () => {
    const { fetch } = setup(created);
    const res = await fetch(post('/orders/ord_1/pay', {}, { 'x-user': 'u1' }));
    expect(res.status).toBe(400);
  });

  it('frees the key after a 5xx, a 409, a 429 or a throw, so the client can retry', async () => {
    for (const status of [500, 503, 409, 429]) {
      const { fetch, calls } = setup(() => new Response('no', { status }));
      await fetch(post('/orders', {}, keyed));
      await fetch(post('/orders', {}, keyed));
      expect(calls()).toBe(2);
    }
    const { fetch, calls } = setup(() => {
      throw new Error('boom');
    });
    await expect(fetch(post('/orders', {}, keyed))).resolves.toHaveProperty('status', 500);
    await fetch(post('/orders', {}, keyed));
    expect(calls()).toBe(2);
  });

  it('stores a 4xx answer: the same bad request keeps getting the same answer', async () => {
    const { fetch, calls } = setup(() => new Response('bad', { status: 422 }));
    await fetch(post('/orders', {}, keyed));
    const again = await fetch(post('/orders', {}, keyed));
    expect(again.status).toBe(422);
    expect(calls()).toBe(1);
  });

  it('does not store a response over maxBodyBytes, and runs an oversized request body unprotected', async () => {
    const big = setup(() => new Response('x'.repeat(100), { status: 200 }), { maxBodyBytes: 50 });
    await big.fetch(post('/orders', {}, keyed));
    await big.fetch(post('/orders', {}, keyed));
    expect(big.calls()).toBe(2);
    expect(big.cache.entries.size).toBe(0);

    const small = setup(created, { maxBodyBytes: 50 });
    const hugeBody = { text: 'y'.repeat(200) };
    await small.fetch(post('/orders', hugeBody, keyed));
    await small.fetch(post('/orders', hugeBody, keyed));
    expect(small.calls()).toBe(2);
  });

  it('caps a chunked request body by counting bytes, not by trusting content-length', async () => {
    // No content-length: before the cap counted bytes, the whole stream was buffered first.
    const { cache, fetch, calls } = setup(
      async req => {
        const text = await req.text();
        return Response.json({ size: text.length });
      },
      { maxBodyBytes: 50 },
    );
    const first = await fetch(chunkedPost(80));
    await fetch(chunkedPost(80));
    expect(calls()).toBe(2);
    expect(cache.entries.size).toBe(0);
    // The handler still gets the whole body: the cap only read a clone.
    expect(await first.json()).toEqual({ size: 80 });
  });

  it('lets the handler read the body after the middleware fingerprinted it', async () => {
    const { fetch } = setup(async req => Response.json(await req.json(), { status: 201 }));
    const res = await fetch(post('/orders', { sku: 7 }, keyed));
    expect(await res.json()).toEqual({ sku: 7 });
  });

  it('treats query order as irrelevant but query content as part of the request', async () => {
    const { fetch, calls } = setup(created);
    const call = (query: string) =>
      fetch(new Request(`http://x/orders${query}`, { method: 'POST', headers: keyed, body: '{}' }));
    await call('?a=1&b=2');
    const reordered = await call('?b=2&a=1');
    const changed = await call('?a=1&b=3');
    expect(reordered.headers.get('idempotent-replayed')).toBe('true');
    expect(changed.status).toBe(422);
    expect(calls()).toBe(1);
  });
});
