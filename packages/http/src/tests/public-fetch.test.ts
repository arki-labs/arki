import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createClient } from '../client.js';
import { route } from '../contract.js';
import { HTTP_ERROR_CODES } from '../error.js';
import { publicFetch, safeFetchBytes, UnsafeUrlError, validatePublicURL } from '../public-fetch.js';

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
  mocks.destroy.mockResolvedValue(undefined);
});

describe('public fetch boundary', () => {
  it('rejects mixed public/private DNS before opening a connection', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(safeFetchBytes('https://example.com')).rejects.toThrow('Private network');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('validates redirect targets before connecting to metadata services', async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254' } }));
    await expect(safeFetchBytes('https://example.com')).rejects.toThrow('Private network');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it('strips conditional credentials on cross-origin redirects', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://other.example/feed' } }),
    );
    mocks.fetch.mockResolvedValueOnce(new Response('ok'));
    await safeFetchBytes('https://example.com', { headers: { Authorization: 'secret' } });
    expect(mocks.fetch.mock.calls[1]?.[1].headers).toEqual({});
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });

  it('caps body bytes and closes the pinned dispatcher on failure', async () => {
    mocks.fetch.mockResolvedValue(new Response('oversized'));
    await expect(safeFetchBytes('https://example.com', { maxBytes: 2 })).rejects.toThrow('size limit');
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
    await expect(safeFetchBytes('https://example.com')).rejects.toThrow('redirect limit');
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
    await expect(safeFetchBytes('https://internal.example', { transport })).rejects.toThrow('Private network');
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
    const result = await safeFetchBytes('https://example.com/feed', { transport });
    expect(new TextDecoder().decode(result.bytes)).toBe('hello');
    expect(result.status).toBe(200);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('credentials in the URL', () => {
  // WHY: private feeds carry `user:pass@`. They must still pass every address check, must never be sent to
  // another origin, and must never appear in the URL that is requested, returned or logged.
  it('refuses credentials by default and accepts them only when asked', () => {
    expect(() => validatePublicURL('https://u:p@example.com/feed')).toThrow('Only public HTTP feeds');
    expect(validatePublicURL('https://u:p@example.com/feed', { allowCredentials: true }).hostname).toBe('example.com');
    expect(() => validatePublicURL('https://u:p@127.0.0.1/feed', { allowCredentials: true })).toThrow(
      'Private network',
    );
    expect(() => validatePublicURL('not a url')).toThrow('Invalid URL.');
  });

  it('sends them as a Basic Authorization header and strips them from the request URL', async () => {
    mocks.fetch.mockResolvedValue(new Response('ok'));
    const result = await safeFetchBytes('https://u%40x:p%3Ass@example.com/feed', { allowCredentials: true });
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
    await safeFetchBytes('https://u:p@example.com/feed', { allowCredentials: true });
    expect(mocks.fetch.mock.calls[1]?.[1].headers).toEqual({ authorization: `Basic ${btoa('u:p')}` });
    expect(mocks.fetch.mock.calls[2]?.[1].headers).toEqual({});
  });

  it('still refuses a private host that carries credentials, before any lookup', async () => {
    await expect(safeFetchBytes('https://u:p@10.0.0.1/feed', { allowCredentials: true })).rejects.toThrow(
      'Private network',
    );
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
    await safeFetchBytes('https://example.com/hook', { method: 'POST', body: '{"a":1}' });
    expect(mocks.fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '{"a":1}' });
    expect(mocks.fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'GET', body: undefined });
  });

  it('a 307 replays the POST and its body at the validated target', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { location: 'https://example.com/v2/hook' } }),
    );
    mocks.fetch.mockResolvedValueOnce(new Response('ok'));
    await safeFetchBytes('https://example.com/hook', { method: 'POST', body: '{"a":1}' });
    expect(mocks.fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{"a":1}' });
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });

  it('a POST redirected to a private address is refused before any second request', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { location: 'http://10.0.0.1/hook' } }),
    );
    await expect(safeFetchBytes('https://example.com/hook', { method: 'POST', body: '{}' })).rejects.toThrow(
      'Private network',
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});

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
    await expect(publicFetch()('https://api.example.com/orders/o1')).rejects.toThrow('Private network');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('refuses a redirect to a private address, so a public API cannot bounce the call inside', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
    );
    await expect(publicFetch()('https://api.example.com/orders/o1')).rejects.toThrow('Private network');
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
    await expect(publicFetch({ timeoutMs: 20 })('https://api.example.com/slow')).rejects.toThrow();
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it('caps the buffered body at maxBytes', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('0123456789'));
    await expect(publicFetch({ maxBytes: 4 })('https://api.example.com/big')).rejects.toThrow('size limit');
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
// not report it as "the server is down". A network failure may pass on a later try. The two used
// to throw the same plain Error; the refusal now has its own class, so a caller can tell them apart.
describe('UnsafeUrlError: a refusal, not a network failure', () => {
  const PUBLIC = { address: '93.184.216.34', family: 4 };

  it('a private, loopback or link-local address in the URL is refused before any lookup', async () => {
    const transport = { lookup: vi.fn(), fetch: vi.fn() };
    const urls = [
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://169.254.169.254/latest',
      'https://[::1]/',
    ];
    const errors = await Promise.all(urls.map(url => rejection(safeFetchBytes(url, { transport }))));
    for (const error of errors) {
      expect(error).toBeInstanceOf(UnsafeUrlError);
      expect(error).toMatchObject({
        code: HTTP_ERROR_CODES.unsafeUrl,
        message: 'Private network addresses are not allowed.',
      });
    }
    expect(transport.lookup).not.toHaveBeenCalled();
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('a hostname whose DNS answer is private is refused before the request', async () => {
    const transport = { lookup: vi.fn().mockResolvedValue([{ address: '192.168.1.20', family: 4 }]), fetch: vi.fn() };
    const error = await rejection(safeFetchBytes('https://hooks.example/x', { transport }));
    expect(error).toBeInstanceOf(UnsafeUrlError);
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('a redirect to a private address is refused, and never followed', async () => {
    const transport = {
      lookup: vi.fn().mockResolvedValue([PUBLIC]),
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/' } })),
    };
    const error = await rejection(safeFetchBytes('https://hooks.example/x', { method: 'POST', body: '{}', transport }));
    expect(error).toBeInstanceOf(UnsafeUrlError);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(transport.lookup).toHaveBeenCalledTimes(1);
  });

  it('a bad scheme, refused credentials, or no URL at all is refused too, with a remediation', () => {
    for (const url of ['ftp://example.com/feed', 'https://u:p@example.com/feed', 'not a url']) {
      expect(() => validatePublicURL(url)).toThrow(UnsafeUrlError);
    }
    expect(new UnsafeUrlError('x').remediation).toMatch(/public addresses/);
  });

  it('publicFetch refuses with the same class', async () => {
    const transport = { lookup: vi.fn().mockResolvedValue([{ address: '10.0.0.8', family: 4 }]), fetch: vi.fn() };
    expect(await rejection(publicFetch({ transport })('https://api.example/x'))).toBeInstanceOf(UnsafeUrlError);
  });

  it('a network failure is not a refusal: it keeps the error the network threw', async () => {
    const transport = {
      lookup: vi.fn().mockResolvedValue([PUBLIC]),
      fetch: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    };
    const error = await rejection(safeFetchBytes('https://hooks.example/x', { transport }));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(UnsafeUrlError);
  });
});
