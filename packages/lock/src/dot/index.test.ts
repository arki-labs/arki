/**
 * The `locks` Dot plugin: a feature gets a working lock handle, the store is
 * closed with the app, a process-scope store is refused in production unless
 * the app says it runs one replica, and `describeLocks` tells what the store
 * promises.
 */
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';

import { DotLifecycleError } from '@arki/dot';
import { defineApp, plugin, service } from '@arki/dot/plugin';

import type { MemoryGuarantees } from '../memory.js';
import type { LocksFor } from '../types.js';
import { LockError } from '../errors.js';
import { memoryStore } from '../memory.js';
import { describeLocks, locks } from './index.js';

const originalNodeEnv = process.env['NODE_ENV'];

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = originalNodeEnv;
});

/** A memory store that counts `dispose` calls. */
function trackedStore() {
  const store = memoryStore();
  const calls = { disposed: 0 };
  const dispose = () => {
    calls.disposed += 1;
    return Promise.resolve();
  };
  return { store: Object.assign(store, { dispose }), calls };
}

describe('locks()', () => {
  it('hands a feature a working handle: a second concurrent tryRun is refused while the first holds', async () => {
    const app = await defineApp('locks-works')
      .use(locks({ namespace: 'test', store: () => memoryStore() }))
      .boot();
    const handle = app.services.locks;
    let inner: unknown;
    const outer = await handle.mutex('job').tryRun(async () => {
      inner = await handle.mutex('job').tryRun(() => 'second');
      return 'first';
    });
    expect(outer).toEqual({ ran: true, value: 'first' });
    expect(inner).toEqual({ ran: false });
    await app.dispose();
  });

  it('closes the store when the app stops, so connections do not leak', async () => {
    const { store, calls } = trackedStore();
    const app = await defineApp('locks-dispose')
      .use(locks({ namespace: 'test', store: () => store }))
      .boot();
    expect(app.services.locks).toBeDefined();
    expect(calls.disposed).toBe(0);
    await app.dispose();
    expect(calls.disposed).toBe(1);
  });

  it('builds the store from the services named in needs, so a store can use the app database', async () => {
    const seen: string[] = [];
    const config = plugin({ name: 'config', provides: { dsn: () => 'postgres://x' } });
    const app = await defineApp('locks-needs')
      .use(config)
      .use(
        locks({
          namespace: 'test',
          needs: { dsn: service<string>() },
          store: ({ dsn }) => {
            seen.push(dsn);
            return memoryStore();
          },
        }),
      )
      .boot();
    expect(app.services.locks).toBeDefined();
    expect(seen).toEqual(['postgres://x']);
    await app.dispose();
  });

  it('refuses to boot with a process-scope store in production, because every replica would run the job', async () => {
    process.env['NODE_ENV'] = 'production';
    const failure: unknown = await defineApp('locks-prod')
      .use(locks({ namespace: 'test', store: () => memoryStore() }))
      .start()
      .catch((error: unknown) => error);
    // Dot wraps the plugin's error; the LockError rides along as the cause.
    expect(failure).toBeInstanceOf(DotLifecycleError);
    expect(failure).toMatchObject({ cause: expect.any(LockError) });
    expect(failure).toMatchObject({ cause: { code: 'config' } });
  });

  it('allows a process-scope store in production when allowProcessScope says one replica', async () => {
    process.env['NODE_ENV'] = 'production';
    const app = await defineApp('locks-prod-ok')
      .use(locks({ namespace: 'test', store: () => memoryStore(), allowProcessScope: true }))
      .boot();
    expect(app.services.locks).toBeDefined();
    await app.dispose();
  });

  it('allows a process-scope store outside production, so dev and tests need no setup', async () => {
    process.env['NODE_ENV'] = 'development';
    const app = await defineApp('locks-dev')
      .use(locks({ namespace: 'test', store: () => memoryStore() }))
      .boot();
    expect(app.services.locks).toBeDefined();
    await app.dispose();
  });

  it('types the handle by the store guarantees, so a memory store gives LocksFor<MemoryGuarantees> with no lead', async () => {
    const app = await defineApp('locks-types')
      .use(locks({ namespace: 'test', store: () => memoryStore() }))
      .boot();
    expectTypeOf(app.services.locks).toEqualTypeOf<LocksFor<MemoryGuarantees>>();
    const handle = app.services.locks;
    expectTypeOf(handle.mutex('k')).not.toHaveProperty('lead');
    await app.dispose();
  });
});

describe('describeLocks()', () => {
  it('reports the store name and guarantees, so explain text can say what a job lock promises', async () => {
    const store = memoryStore();
    const app = await defineApp('locks-describe')
      .use(locks({ namespace: 'test', store: () => store }))
      .boot();
    const handle = app.services.locks;
    expect(describeLocks(handle)).toEqual({
      store: store.name,
      kind: store.guarantees.kind,
      scope: 'process',
      fence: store.guarantees.fence,
      releasedOnCrash: store.guarantees.releasedOnCrash,
    });
    await app.dispose();
  });
});
