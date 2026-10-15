/**
 * `lock:` on a feature schedule — one replica at a time, for as long as the
 * job runs. These tests use a fake `locks` service (the real one is
 * `advisoryLocks` from `@arki/db/dot`, tested against Postgres there) and pin
 * what the runtime promises: a held lock is `skipped-lock` and the handler
 * never starts; a broken lock is `lock-failed`; a failing handler is still
 * `handler-failed`; the driver's 60 s KV lease is not used for these jobs;
 * and the lock shows up in the manifest.
 */
import { describe, expect, it } from 'vitest';

import { defineFeature } from '@arki/dot/feature';
import { defineApp, plugin } from '@arki/dot/plugin';

import type { Locker } from './index.js';
import type { KvLike } from './runtime.js';
import { schedule, schedules } from './dot.js';

/** A fake lock service: records each key, and answers as the test says. */
function fakeLocks(answer: () => 'free' | 'held' | 'broken') {
  const keys: string[] = [];
  const locks: Locker = {
    tryRun: async (key, fn) => {
      keys.push(key);
      const state = answer();
      if (state === 'broken') throw new Error('connection lost');
      if (state === 'held') return { ran: false };
      return { ran: true, value: await fn() };
    },
  };
  return { keys, locks };
}

function buildApp(answer: () => 'free' | 'held' | 'broken', driverLease?: KvLike) {
  const fake = fakeLocks(answer);
  let calls = 0;
  const core = defineFeature('clustering')
    .infra(plugin({ name: 'locks', provides: { locks: () => fake.locks } }))
    .usecases(() => ({
      assign: () => {
        calls += 1;
        return 'assigned';
      },
      broken: (): string => {
        throw new Error('handler broke');
      },
    }));
  const clustering = core.entrypoints(
    schedules(core, [
      { name: 'cluster-assign', cron: '*/5 * * * *', lock: true, handler: ({ usecases }) => usecases.assign() },
      { name: 'cluster-batch', cron: '0 */4 * * *', lock: 'clusters', handler: ({ usecases }) => usecases.broken() },
      { name: 'cluster-trending', cron: '0 8 * * *', handler: () => 'unlocked' },
    ]),
  );
  const app = defineApp('locks-app')
    .features([clustering])
    .entrypoints(schedule({ clock: 'host', ...(driverLease === undefined ? {} : { lock: driverLease }) }));
  return { app, fake, calls: () => calls };
}

describe('schedules(core, [{ lock }])', () => {
  it('runs the handler inside the lock, keyed by the schedule name for `lock: true`', async () => {
    const { app, fake, calls } = buildApp(() => 'free');
    const started = await app.start();
    await expect(started.services.scheduler.trigger('cluster-assign')).resolves.toEqual({
      name: 'cluster-assign',
      status: 'ran',
      value: 'assigned',
    });
    expect(fake.keys).toEqual(['cluster-assign']);
    expect(calls()).toBe(1);
    await started.dispose();
  });

  it('a held lock is skipped-lock, and the handler never starts', async () => {
    const { app, calls } = buildApp(() => 'held');
    const started = await app.start();
    await expect(started.services.scheduler.trigger('cluster-assign')).resolves.toEqual({
      name: 'cluster-assign',
      status: 'skipped-lock',
    });
    expect(calls()).toBe(0);
    await started.dispose();
  });

  it('a lock that cannot be taken is lock-failed, not a silent skip', async () => {
    const { app } = buildApp(() => 'broken');
    const started = await app.start();
    await expect(started.services.scheduler.trigger('cluster-assign')).resolves.toMatchObject({
      status: 'lock-failed',
      cause: expect.objectContaining({ message: 'connection lost' }),
    });
    await started.dispose();
  });

  it('a handler that throws inside the lock is handler-failed, and the named key is used', async () => {
    const { app, fake } = buildApp(() => 'free');
    const started = await app.start();
    await expect(started.services.scheduler.trigger('cluster-batch')).resolves.toMatchObject({
      status: 'handler-failed',
      cause: expect.objectContaining({ message: 'handler broke' }),
    });
    expect(fake.keys).toEqual(['clusters']);
    await started.dispose();
  });

  it('ignores the driver KV lease for locked jobs: the lease expires, the job may not', async () => {
    const leaseTaken: KvLike = { setIfNotExists: async () => false };
    const { app } = buildApp(() => 'free', leaseTaken);
    const started = await app.start();
    // The lease says "taken", but the advisory lock decides for this job…
    await expect(started.services.scheduler.trigger('cluster-assign')).resolves.toMatchObject({ status: 'ran' });
    // …while an unlocked job still goes through the lease.
    await expect(started.services.scheduler.trigger('cluster-trending')).resolves.toMatchObject({
      status: 'skipped-lock',
    });
    await started.dispose();
  });

  it('shows the lock policy in the manifest, before anything runs', () => {
    const { app } = buildApp(() => 'free');
    const actions = app.configure().manifest.actions;
    const meta = (id: string) => actions.find(action => action.id === id)?.meta;
    expect(meta('cluster-assign.fire')).toMatchObject({ locked: true, lock: 'cluster-assign' });
    expect(meta('cluster-batch.fire')).toMatchObject({ locked: true, lock: 'clusters' });
    expect(meta('cluster-trending.fire')).toMatchObject({ locked: false });
    expect(meta('cluster-trending.fire')).not.toHaveProperty('lock');
  });

  it('a lock without a `locks` service does not compile', () => {
    const bare = defineFeature('bare').usecases(() => ({ run: () => 1 }));
    // @ts-expect-error the feature has no `locks` service
    schedules(bare, [{ name: 'job', every: '1m', lock: true, handler: ({ usecases }) => usecases.run() }]);
    // Without `lock`, the same feature is fine.
    schedules(bare, [{ name: 'job', every: '1m', handler: ({ usecases }) => usecases.run() }]);
    expect(true).toBe(true);
  });
});
