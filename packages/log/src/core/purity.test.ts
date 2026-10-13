import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Importing any entry must read no env var, write nothing, register no process
// listener and create no default instance (RFC §1: importing does nothing).
// Only reads made from this package's own source count, so the test runner's
// own env reads do not.

const OWN_SOURCE = /packages\/log\/src\/(?:core|node|testing)\/(?!.*\.test\.ts)/;

function fromOwnSource(): boolean {
  const stack = new Error('stack probe').stack ?? '';
  return stack
    .split('\n')
    .slice(2)
    .some(frame => OWN_SOURCE.test(frame));
}

const realEnv = process.env;

afterEach(() => {
  process.env = realEnv;
  vi.restoreAllMocks();
});

function watch(): {
  envReads: string[];
  listeners: ReturnType<typeof vi.spyOn>[];
  writes: ReturnType<typeof vi.spyOn>[];
} {
  const envReads: string[] = [];
  process.env = new Proxy(realEnv, {
    get(target, key, receiver) {
      if (typeof key === 'string' && fromOwnSource()) envReads.push(key);
      return Reflect.get(target, key, receiver);
    },
  });
  const listeners = [
    vi.spyOn(process, 'on'),
    vi.spyOn(process, 'once'),
    vi.spyOn(process, 'addListener'),
    vi.spyOn(process, 'prependListener'),
  ];
  const writes = [vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')];
  return { envReads, listeners, writes };
}

describe('purity', () => {
  it('importing core, node and testing reads no env var, writes nothing and registers no listener', async () => {
    vi.resetModules();
    const { envReads, listeners, writes } = watch();
    await import('../core/index.js');
    await import('../node/index.js');
    await import('../testing/index.js');
    expect(envReads).toEqual([]);
    for (const spy of [...listeners, ...writes]) expect(spy).not.toHaveBeenCalled();
    expect(Reflect.get(globalThis, Symbol.for('@arki/log/default@1'))).toBeUndefined();
  });

  it('the probes do see a call to fromEnv() and a sink factory, so the test above can fail', async () => {
    vi.resetModules();
    const { envReads, listeners } = watch();
    const node = await import('../node/index.js');
    node.fromEnv();
    const sink = node.stderr();
    expect(envReads).toContain('LOG_LEVEL');
    expect(listeners.some(spy => spy.mock.calls.length > 0)).toBe(true);
    await sink.close?.();
  });
});
