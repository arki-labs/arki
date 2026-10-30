/** The factories refuse to run without a URL, with the coded `KVInitializationError` and not a bare `Error`. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KV_INITIALIZATION_ERROR_CODES } from './errors.js';

const loadFactory = async (env: Record<string, string | undefined>) => {
  vi.resetModules();
  vi.doMock('./env.js', () => ({ env: { RATE_LIMIT_PREFIX: 'rl', ...env } }));
  return import('./factory.js');
};

afterEach(() => vi.doUnmock('./env.js'));

describe('factories without a URL', () => {
  it('createKV throws the coded initialization error', async () => {
    const { createKV } = await loadFactory({});
    expect(() => createKV()).toThrowError(
      expect.objectContaining({ name: 'KVInitializationError', code: KV_INITIALIZATION_ERROR_CODES.urlNotConfigured }),
    );
  });

  it('createRateLimitKV throws the coded initialization error', async () => {
    const { createRateLimitKV } = await loadFactory({});
    expect(() => createRateLimitKV()).toThrowError(
      expect.objectContaining({ name: 'KVInitializationError', code: KV_INITIALIZATION_ERROR_CODES.urlNotConfigured }),
    );
  });
});
