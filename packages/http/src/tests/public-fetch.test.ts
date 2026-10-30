import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createClient } from '../client.js';
import { route } from '../contract.js';
import { isFailure, orThrow } from '@arki/failure';

import {
  NetworkFailure,
  RedirectLimit,
  RequestTimeout,
  ResponseTooLarge,
  UnsafeUrl,
} from '../failures.js';
import { fetchAllowedHosts, publicFetch, safeFetchBytes, validatePublicURL } from '../public-fetch.js';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), fetch: vi.fn(), destroy: vi.fn(), agent: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('undici/index.js', () => ({
  fetch: mocks.fetch,
  Agent: class {
    constructor(options: unknown) {
      mocks.agent(options);
    }
    destroy = mocks.destroy;
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  mocks.destroy.mockImplementation(() => Promise.resolve());
});

describe('public fetch boundary', () => {
  it('rejects mixed public/private DNS before opening a connection', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    expect(await safeFetchBytes('https://example.com')).toMatchObject({ code: UnsafeUrl.code, data: { reason: 'private_address' } });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('validates redirect targets before connecting to metadata services', async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254' } }));
    expect(await safeFetchBytes('https://example.com')).toMatchObject({ code: UnsafeUrl.code, data: { reason: 'private_address' } });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it('strips conditional credentials on cross-origin redirects', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://other.example/feed' } }),
    );
    mocks.fetch.mockResolvedValueOnce(new Response('ok'));
    orThrow(await safeFetchBytes('https://example.com', { headers: { Authorization: 'secret' } }));
    expect(mocks.fetch.mock.calls[1]?.[1].headers).toEqual({});
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });

  it('caps body bytes and closes the pinned dispatcher on failure', async () => {
    mocks.fetch.mockResolvedValue(new Response('oversized'));
    expect(await safeFetchBytes('https://example.com', { maxBytes: 2 })).toMatchObject({ code: ResponseTooLarge.code });
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    const options = mocks.agent.mock.calls[0]?.[0];
    const callback = vi.fn();
    options.connect.lookup('example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  });

  it('stops redirect loops after the configured five hops', async () => {
    mocks.fetch.mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: '/again' } })),
    );
    expect(await safeFetchBytes('https://example.com')).toMatchObject({ code: RedirectLimit.code });
    expect(mocks.fetch).toHaveBeenCalledTimes(6);
  });
});

describe('injected transport', () => {
  // WHY: a consumer's test must prove the address checks with a fake network, not by mocking modules.
  it('uses the passed lookup and fetch, and still refuses a hostname that resolves to a private address', async () => {
    const transport = {
      lookup: vi.fn().mockResolvedValue([{ address: '10.0.0.8', family: 4 }]),
      fetch: vi.fn(),
    };
    expect(await safeFetchBytes('https://internal.example', { transport })).toMatchObject({ code: UnsafeUrl.code, data: { reason: 'private_address' } });
    expect(transport.lookup).toHaveBeenCalledWith('internal.example');
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('serves a public host through the passed fetch', async () => {
    const transport = {
      lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
      fetch: vi.fn().mockResolvedValue(new Response('hello', { status: 200 })),
    };
    const result = orThrow(await safeFetchBytes('https://example.com/feed', { transport }));
    expect(new TextDecoder().decode(result.bytes)).toBe('hello');
    expect(result.status).toBe(200);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('credentials in the URL', () => {
  // WHY: private feeds carry `user:pass@`. They must still pass every address check, must never be sent to
  // another origin, and must never appear in the URL that is requested, returned or logged.
  it('refuses credentials by default and accepts them only when asked', () => {
    expect(validatePublicURL('https://u:p@example.com/feed')).toMatchObject({
      code: UnsafeUrl.code,
      message: 'Only public HTTP feeds are supported.',
    });
    expect(validatePublicURL('https://u:p@example.com/feed', { allowCredentials: true })).toMatchObject({
      hostname: 'example.com',
    });
    expect(validatePublicURL('https://u:p@127.0.0.1/feed', { allowCredentials: true })).toMatchObject({
      message: 'Private network addresses are not allowed.',
    });
    expect(validatePublicURL('not a url')).toMatchObject({ code: UnsafeUrl.code, message: 'Invalid URL.' });
  });

  it('sends them as a Basic Authorization header and strips them from the request URL', async () => {
    mocks.fetch.mockResolvedValue(new Response('ok'));
    const result = orThrow(await safeFetchBytes('https://u%40x:p%3Ass@example.com/feed', { allowCredentials: true }));
    const [requestUrl, init] = mocks.fetch.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe('https://example.com/feed');
    expect(init.headers).toEqual({ authorization: `Basic ${btoa('u@x:p:ss')}` });
    expect(result.url).toBe('https://example.com/feed');
  });

  it('keeps the header on a same-origin redirect and drops it on a cross-origin one', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/moved' } }));
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://other.example/feed' } }),
    );
    mocks.fetch.mockResolvedValueOnce(new Response('ok'));
    orThrow(await safeFetchBytes('https://u:p@example.com/feed', { allowCredentials: true }));
    expect(mocks.fetch.mock.calls[1]?.[1].headers).toEqual({ authorization: `Basic ${btoa('u:p')}` });
    expect(mocks.fetch.mock.calls[2]?.[1].headers).toEqual({});
  });

  it('still refuses a private host that carries credentials, before any lookup', async () => {
    expect(await safeFetchBytes('https://u:p@10.0.0.1/feed', { allowCredentials: true })).toMatchObject({ code: UnsafeUrl.code, data: { reason: 'private_address' } });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
});

describe('request method and body', () => {
  // WHY: a webhook POST must be re-validated on redirect like a GET, and must not replay its body to a GET target.
  it('sends the method and body, and a 303 turns the POST into a bodiless GET', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, { status: 303, headers: { location: 'https://example.com/done' } }),
    );
    mocks.fetch.mockResolvedValueOnce(new Response('ok'));
    orThrow(await safeFetchBytes('https://example.com/hook', { method: 'POST', body: '{"a":1}' }));
    expect(mocks.fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '{"a":1}' });
    expect(mocks.fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'GET', body: undefined });
  });

  it('a 307 replays the POST and its body at the validated target', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { location: 'https://example.com/v2/hook' } }),
    );
    mocks.fetch.mockResolvedValueOnce(new Response('ok'));
    orThrow(await safeFetchBytes('https://example.com/hook', { method: 'POST', body: '{"a":1}' }));
    expect(mocks.fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{"a":1}' });
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });

  it('a POST redirected to a private address is refused before any second request', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { location: 'http://10.0.0.1/hook' } }),
    );
    expect(await safeFetchBytes('https://example.com/hook', { method: 'POST', body: '{}' })).toMatchObject({ code: UnsafeUrl.code, data: { reason: 'private_address' } });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * A `fetch` can only resolve a Response or reject. publicFetch rejects the way fetch does for a
 * network error, with a TypeError whose cause is the typed failure; this answers that failure.
 */
async function refusal(promise: Promise<unknown>) {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(TypeError);
  return error instanceof Error ? error.cause : undefined;
}

describe('publicFetch: the guard as a fetch, for the typed client', () => {
  const getOrder = route.get('/orders/:id', {
    id: 'orders.get',
    params: { id: z.string() },
    output: z.object({ id: z.string() }),
  });

  it('serves a typed client: request through the pinned connection, response as a Response', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response('{"id":"o1"}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const orders = createClient({ getOrder }, { baseUrl: 'https://api.example.com', fetch: publicFetch() });
    await expect(orders.getOrder({ params: { id: 'o1' } })).resolves.toEqual({ id: 'o1' });
    expect(mocks.fetch.mock.calls[0]?.[0].href).toBe('https://api.example.com/orders/o1');
    expect(mocks.fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it('refuses a host whose DNS answer is private, before any connection', async () => {
    mocks.lookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
    expect(await refusal(publicFetch()('https://api.example.com/orders/o1'))).toMatchObject({ code: UnsafeUrl.code });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('refuses a redirect to a private address, so a public API cannot bounce the call inside', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
    );
    expect(await refusal(publicFetch()('https://api.example.com/orders/o1'))).toMatchObject({ code: UnsafeUrl.code });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('sends the method, headers and body, and a 204 comes back with no body', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const response = await publicFetch()('https://api.example.com/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
      body: '{"total":5}',
    });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(mocks.fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
      body: '{"total":5}',
    });
  });

  it('a server that never answers is cut off by the default deadline, so it cannot hold the connection', async () => {
    mocks.fetch.mockImplementation(
      (_url: URL, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted', { cause: init.signal.reason })));
        }),
    );
    expect(await refusal(publicFetch({ timeoutMs: 20 })('https://api.example.com/slow'))).toMatchObject({
      code: RequestTimeout.code,
    });
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it('caps the buffered body at maxBytes', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('0123456789'));
    expect(await refusal(publicFetch({ maxBytes: 4 })('https://api.example.com/big'))).toMatchObject({
      code: ResponseTooLarge.code,
    });
  });
});

/** Runs `promise` and answers what it rejected with (it must reject). */
async function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => expect.unreachable('the fetch should have been refused'),
    (error: unknown) => error,
  );
}

// WHY: a refused URL is refused the same way every time, so a caller must not retry it, and must
// not report it as "the server is down". A network failure may pass on a later try. Each outcome
// has its own failure code, so a caller can tell them apart without parsing a message.
describe('UnsafeUrl: a refusal, not a network failure', () => {
  const PUBLIC = { address: '93.184.216.34', family: 4 };

  it('a private, loopback or link-local address in the URL is refused before any lookup', async () => {
    const transport = { lookup: vi.fn(), fetch: vi.fn() };
    const urls = [
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://169.254.169.254/latest',
      'https://[::1]/',
    ];
    const results = await Promise.all(urls.map(url => safeFetchBytes(url, { transport })));
    for (const result of results) {
      expect(isFailure(result)).toBe(true);
      expect(result).toMatchObject({
        code: UnsafeUrl.code,
        message: 'Private network addresses are not allowed.',
        data: { reason: 'private_address' },
      });
    }
    expect(transport.lookup).not.toHaveBeenCalled();
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('a hostname whose DNS answer is private is refused before the request', async () => {
    const transport = { lookup: vi.fn().mockResolvedValue([{ address: '192.168.1.20', family: 4 }]), fetch: vi.fn() };
    expect(UnsafeUrl.is(await safeFetchBytes('https://hooks.example/x', { transport }))).toBe(true);
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('a redirect to a private address is refused, and never followed', async () => {
    const transport = {
      lookup: vi.fn().mockResolvedValue([PUBLIC]),
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/' } })),
    };
    const result = await safeFetchBytes('https://hooks.example/x', { method: 'POST', body: '{}', transport });
    expect(UnsafeUrl.is(result)).toBe(true);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(transport.lookup).toHaveBeenCalledTimes(1);
  });

  it('a bad scheme, refused credentials, or no URL at all is refused too, with a remediation', () => {
    for (const url of ['ftp://example.com/feed', 'https://u:p@example.com/feed', 'not a url']) {
      expect(UnsafeUrl.is(validatePublicURL(url))).toBe(true);
    }
    expect(UnsafeUrl({ reason: 'invalid_url' }).remediation).toMatch(/public addresses/);
  });

  it('publicFetch refuses with the same failure, as the cause of the TypeError a fetch rejects with', async () => {
    const transport = { lookup: vi.fn().mockResolvedValue([{ address: '10.0.0.8', family: 4 }]), fetch: vi.fn() };
    expect(UnsafeUrl.is(await refusal(publicFetch({ transport })('https://api.example/x')))).toBe(true);
  });

  it('a network failure is not a refusal: it is NetworkFailure with the error the network threw as its cause', async () => {
    const networkError = new TypeError('fetch failed');
    const transport = {
      lookup: vi.fn().mockResolvedValue([PUBLIC]),
      fetch: vi.fn().mockRejectedValue(networkError),
    };
    const result = await safeFetchBytes('https://hooks.example/x', { transport });
    expect(NetworkFailure.is(result)).toBe(true);
    expect(UnsafeUrl.is(result)).toBe(false);
    expect(isFailure(result) ? result.cause : undefined).toBe(networkError);
  });

  it('a DNS error is a NetworkFailure, not a throw', async () => {
    const transport = { lookup: vi.fn().mockRejectedValue(new Error('ENOTFOUND')), fetch: vi.fn() };
    expect(NetworkFailure.is(await safeFetchBytes('https://nowhere.example/x', { transport }))).toBe(true);
  });

  it('a server that never answers is a RequestTimeout failure', async () => {
    const transport = {
      lookup: vi.fn().mockResolvedValue([PUBLIC]),
      fetch: vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    };
    expect(RequestTimeout.is(await safeFetchBytes('https://slow.example/x', { transport, timeoutMs: 10 }))).toBe(true);
  });

  it('a caller abort through publicFetch rejects with the abort reason, as fetch does', async () => {
    const controller = new AbortController();
    const reason = new DOMException('stop', 'AbortError');
    controller.abort(reason);
    const transport = { lookup: vi.fn().mockResolvedValue([PUBLIC]), fetch: vi.fn() };
    expect(await rejection(publicFetch({ transport })('https://api.example/x', { signal: controller.signal }))).toBe(
      reason,
    );
  });
});

describe('the test-only host allowance', () => {
  // WHY: an end-to-end test fetches a feed from a server on this machine; nothing else private may open.
  afterEach(() => {
    delete process.env['FETCH_ALLOW_HOSTS'];
  });
  const loopbackTransport = () => ({
    lookup: vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]),
    fetch: vi.fn().mockResolvedValue(new Response('feed', { status: 200 })),
  });

  it('fetches a listed host:port at a loopback address', async () => {
    process.env['FETCH_ALLOW_HOSTS'] = '127.0.0.1:4567';
    const transport = loopbackTransport();
    const result = orThrow(await safeFetchBytes('http://127.0.0.1:4567/feed', { transport }));
    expect(new TextDecoder().decode(result.bytes)).toBe('feed');
  });

  it('still refuses a loopback host or port that is not listed', async () => {
    process.env['FETCH_ALLOW_HOSTS'] = '127.0.0.1:4567';
    expect(await safeFetchBytes('http://127.0.0.1:9999/feed', { transport: loopbackTransport() })).toMatchObject({ code: UnsafeUrl.code, data: { reason: 'private_address' } });
    expect(await safeFetchBytes('http://localhost:4567/feed', { transport: loopbackTransport() })).toMatchObject({ code: UnsafeUrl.code, data: { reason: 'private_address' } });
  });

  it('refuses to run in production with the allowance set', () => {
    expect(() => fetchAllowedHosts({ FETCH_ALLOW_HOSTS: '127.0.0.1:4567', NODE_ENV: 'production' })).toThrow('tests only');
    expect(fetchAllowedHosts({ NODE_ENV: 'production' }).size).toBe(0);
  });
});
