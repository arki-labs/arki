import { beforeEach, describe, expect, it, vi } from 'vitest';

import { safeFetchBytes } from '../public-fetch.js';

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
