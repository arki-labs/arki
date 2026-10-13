/**
 * A library must never end the host program. In production a missing KV_URL
 * has to surface as a catchable error, not a process exit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KV_INITIALIZATION_ERROR_CODES } from './errors.js';

const loadInstance = async (nodeEnv: 'production' | 'development') => {
  vi.doMock('./env.js', () => ({
    env: { NODE_ENV: nodeEnv, KV_URL: undefined, KV_NAMESPACE: undefined },
  }));
  return import('./instance.js');
};

describe('@arki/kv/instance', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    vi.doUnmock('./env.js');
  });

  it('throws a KVInitializationError in production without KV_URL', async () => {
    await expect(loadInstance('production')).rejects.toMatchObject({
      name: 'KVInitializationError',
      code: KV_INITIALIZATION_ERROR_CODES.urlRequiredInProduction,
    });
  });

  it('returns null in development without KV_URL', async () => {
    vi.spyOn(console, 'warn').mockReturnValue();
    const instance = await loadInstance('development');
    expect(instance.createKVInstance()).toBeNull();
    await expect(instance.initializeKV()).resolves.toBeNull();
  });

  it('initializeKV rejects with a KVInitializationError in production without KV_URL', async () => {
    const mutableEnv = { NODE_ENV: 'development', KV_URL: undefined, KV_NAMESPACE: undefined };
    vi.doMock('./env.js', () => ({ env: mutableEnv }));
    const instance = await import('./instance.js');
    mutableEnv.NODE_ENV = 'production';
    await expect(instance.initializeKV()).rejects.toMatchObject({ name: 'KVInitializationError' });
  });
});
