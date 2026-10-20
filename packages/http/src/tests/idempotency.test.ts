/**
 * `idempotent()` runs a mutating request once per key. These tests use an in-memory
 * `ResponseCache` double, so they show the middleware's rules and not a store's.
 * The test double lives here, not in the public API: each real store (Postgres, Redis)
 * has its own cache, and a map-backed one would hide the atomicity they must provide.
 */
import { describe, expect, it } from 'vitest';

import type {
  BeginResult,
  IdempotencyOwnerId,
  IdempotentOptions,
  ResponseCache,
  StoredResponse,
} from '../idempotency.js';
import { route } from '../contract.js';
import { composeMiddleware } from '../engine.js';
import { IDEMPOTENCY_FAILURES, IdempotencyOwnershipLost, idempotent } from '../idempotency.js';

type Entry = { fingerprint: string; owner: IdempotencyOwnerId; expiresAt?: number; response?: StoredResponse };

function memoryCache(now: () => number = Date.now): ResponseCache & { readonly entries: Map<string, Entry> } {
  const entries = new Map<string, Entry>();
  return {
    entries,
    begin: (key, fingerprint, owner): Promise<BeginResult> => {
      const held = entries.get(key);
      if (held === undefined || (held.expiresAt !== undefined && held.expiresAt <= now())) {
        entries.set(key, { fingerprint, owner });
        return Promise.resolve('started');
      }
      if (held.fingerprint !== fingerprint) return Promise.resolve('conflict');
      return Promise.resolve(held.response === undefined ? 'in-progress' : { replay: held.response });
    },
    finish: (key, owner, response, ttl) => {
      const held = entries.get(key);
      if (held?.owner !== owner) return Promise.resolve(IdempotencyOwnershipLost());
      held.response = response;
      held.expiresAt = now() + ttl;
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
  overrides: Partial<Omit<IdempotentOptions, 'routes'>> = {},
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
        routes: [
          route.post('/orders', { id: 'orders.create', failures: IDEMPOTENCY_FAILURES }),
          route.post('/orders/:id/pay', { id: 'orders.pay', failures: IDEMPOTENCY_FAILURES }),
        ],
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
    expect(await res.json()).toMatchObject({ error: { code: 'http.idempotency_key_reused' } });
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
    expect(await missing.json()).toMatchObject({ error: { code: 'http.idempotency_key_required' } });
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

  it.each([200, 201, 204, 205, 301, 304, 409, 422, 429, 500, 503, 599])(
    'retains a finite %i response because an error status does not prove the write did not happen',
    async status => {
      const body = [204, 205, 304].includes(status) ? null : 'answer';
      const { fetch, calls } = setup(() => new Response(body, { status }));
      const first = await fetch(post('/orders', {}, keyed));
      const replay = await fetch(post('/orders', {}, keyed));
      expect(replay.status).toBe(status);
      expect(await replay.text()).toBe(await first.text());
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      expect(calls()).toBe(1);
    },
  );

  it('retains ownership after a handler throws because its effects may already have committed', async () => {
    const { fetch, calls, cache } = setup(() => {
      throw new Error('boom');
    });
    await expect(fetch(post('/orders', {}, keyed))).resolves.toMatchObject({ status: 500 });
    const retry = await fetch(post('/orders', {}, keyed));
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: 'http.idempotency_in_progress' } });
    expect(calls()).toBe(1);
    expect(cache.entries.size).toBe(1);
  });

  it('stores a 4xx answer: the same bad request keeps getting the same answer', async () => {
    const { fetch, calls } = setup(() => new Response('bad', { status: 422 }));
    await fetch(post('/orders', {}, keyed));
    const again = await fetch(post('/orders', {}, keyed));
    expect(again.status).toBe(422);
    expect(calls()).toBe(1);
  });

  it('retains an unresolved reservation when the response exceeds the cap', async () => {
    const { fetch, calls, cache } = setup(() => new Response('x'.repeat(100)), { maxBodyBytes: 50 });
    const first = await fetch(post('/orders', {}, keyed));
    expect(first.status).toBe(500);
    expect(await first.json()).toMatchObject({ error: { code: 'http.idempotency_response_unavailable' } });
    await expect(fetch(post('/orders', {}, keyed))).resolves.toMatchObject({ status: 409 });
    expect(calls()).toBe(1);
    expect(cache.entries.size).toBe(1);
  });

  it.each(['declared', 'buffered', 'chunked'])(
    'refuses an oversized %s request before any unprotected effects',
    async kind => {
      const { fetch, calls, cache } = setup(created, { maxBodyBytes: 50 });
      const request = () =>
        kind === 'chunked'
          ? chunkedPost(80)
          : post(
              '/orders',
              { text: 'y'.repeat(200) },
              {
                ...keyed,
                ...(kind === 'declared' ? { 'content-length': '211' } : {}),
              },
            );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(request());
        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject({ error: { code: 'http.idempotency_request_too_large' } });
      }
      expect(calls()).toBe(0);
      expect(cache.entries.size).toBe(0);
    },
  );

  it('keeps pending claims past the TTL and starts replay retention only at finish', async () => {
    let now = 0;
    const cache = memoryCache(() => now);
    let finishHandler: (() => void) | undefined;
    let startedHandler: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      startedHandler = resolve;
    });
    const gate = new Promise<void>(resolve => {
      finishHandler = resolve;
    });
    const { fetch, calls } = setup(
      async () => {
        startedHandler?.();
        await gate;
        return new Response('done');
      },
      { cache, ttl: 100 },
    );
    const first = fetch(post('/orders', {}, keyed));
    await started;
    now = 1000;
    await expect(fetch(post('/orders', {}, keyed))).resolves.toMatchObject({ status: 409 });
    expect(calls()).toBe(1);
    finishHandler?.();
    await first;
    now = 1099;
    const retained = await fetch(post('/orders', {}, keyed));
    expect(retained.headers.get('idempotent-replayed')).toBe('true');
    now = 1100;
    const expired = await fetch(post('/orders', {}, keyed));
    expect(expired.headers.get('idempotent-replayed')).toBeNull();
    expect(calls()).toBe(2);
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
