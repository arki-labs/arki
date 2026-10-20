import { afterEach, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';
import { UnexpectedDefect } from '@arki/failure';

import type { ResponseCache } from '../idempotency.js';
import { createClient } from '../client.js';
import { route } from '../contract.js';
import { composeMiddleware } from '../engine.js';
import { IDEMPOTENCY_FAILURES, idempotencyOwnerId, idempotent } from '../idempotency.js';

const uuid = '8b91ca18-3fce-42c4-af7b-f551178de374';
const secure = globalThis.crypto;
const endpoint = route.post('/write', { id: 'write', failures: IDEMPOTENCY_FAILURES });

const request = () =>
  new Request('https://example.test/write', {
    method: 'POST',
    headers: { user: 'private user', 'idempotency-key': 'private token' },
  });

function setup() {
  const cache = {
    begin: vi.fn<ResponseCache['begin']>(() => Promise.resolve('started')),
    finish: vi.fn(() => Promise.resolve()),
    abandon: vi.fn(() => Promise.resolve()),
  } satisfies ResponseCache;
  const handler = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  const fetch = composeMiddleware(handler, [
    idempotent({ cache, scope: req => req.headers.get('user') ?? undefined, routes: [endpoint], ttl: 10_000 }),
  ]);
  return { cache, handler, fetch, request };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('idempotency owner generation', () => {
  it('preserves native UUID bytes and passes the same nominal owner to begin and finish', async () => {
    const randomUUID = vi.fn(() => uuid);
    vi.stubGlobal('crypto', { randomUUID, subtle: secure.subtle });
    const { cache, handler, fetch, request } = setup();
    const response = await fetch(request());
    expect(response.status).toBe(204);
    const owner = idempotencyOwnerId.schema.parse(uuid);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(cache.begin).toHaveBeenCalledWith(expect.any(String), expect.any(String), owner);
    expect(cache.finish).toHaveBeenCalledWith(expect.any(String), owner, expect.objectContaining({ status: 204 }), 10_000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('uses secure fallback bytes when native UUID generation is unavailable', async () => {
    const getRandomValues = vi.fn((bytes: Uint8Array<ArrayBuffer>) => secure.getRandomValues(bytes));
    vi.stubGlobal('crypto', { getRandomValues, subtle: secure.subtle });
    const { cache, fetch, request } = setup();
    const response = await fetch(request());
    expect(response.status).toBe(204);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    const owner = vi.mocked(cache.begin).mock.calls[0]?.[2];
    expect(owner).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  });

  it('returns the canonical unavailable failure before hashing or any cache/handler work', async () => {
    vi.stubGlobal('crypto', null);
    const { cache, handler, fetch, request } = setup();
    const response = await fetch(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: RandomSourceUnavailable.code } });
    expect(cache.begin).not.toHaveBeenCalled();
    expect(cache.finish).not.toHaveBeenCalled();
    expect(cache.abandon).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves the exact canonical owner refusal across the framework exception bridge', async () => {
    const refusal = RandomSourceUnavailable();
    vi.spyOn(idempotencyOwnerId, 'create').mockReturnValueOnce(refusal);
    const { cache, handler, fetch, request } = setup();
    const response = await fetch(request());
    expect(await response.json()).toMatchObject({ error: { code: refusal.code, message: refusal.message } });
    expect(cache.begin).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not fallback after native faults, and the typed client revives the defect safely', async () => {
    const getRandomValues = vi.fn((bytes: Uint8Array<ArrayBuffer>) => secure.getRandomValues(bytes));
    vi.stubGlobal('crypto', {
      randomUUID() {
        throw new Error('private provider credentials');
      },
      getRandomValues,
      subtle: secure.subtle,
    });
    const { cache, handler, fetch } = setup();
    const call = createClient(endpoint, {
      baseUrl: 'https://example.test',
      fetch: (url, init) => fetch(new Request(url, init)),
    });
    const result = await call(undefined, { headers: { user: 'private user', 'idempotency-key': 'private token' } });
    expect(UnexpectedDefect.is(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private provider credentials');
    expect(getRandomValues).not.toHaveBeenCalled();
    expect(cache.begin).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not require entropy for unprotected or unauthenticated bypasses', async () => {
    vi.stubGlobal('crypto', null);
    const { cache, handler, fetch } = setup();
    const unprotected = await fetch(new Request('https://example.test/unprotected'));
    const unauthenticated = await fetch(new Request('https://example.test/write', { method: 'POST' }));
    expect(unprotected.status).toBe(204);
    expect(unauthenticated.status).toBe(204);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(cache.begin).not.toHaveBeenCalled();
  });
});
