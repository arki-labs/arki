/**
 * `lock:` on a feature schedule — one replica at a time, for as long as the
 * job runs and for at least `holdAtLeast` after it started. These tests use
 * the real `createLocks` over the memory store from `@arki/lock`, with a manual
 * clock, and pin what the runtime promises: a held lock is `skipped-lock` and
 * the handler never starts; a broken lock is `lock-failed`; a failing handler
 * is still `handler-failed`; a short job keeps its key through the hold; the
 * run (and a shutdown drain) ends only after the release; the handler sees the
 * lock's `signal` and `fence`; each lock failure kind has its own counter; and
 * the lock shows up in the manifest.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Grant, Key, Locks, Store } from '@arki/lock';
import type { FileStore } from '@arki/lock/file';
import type { MemoryStore } from '@arki/lock/memory';
import type { PgSessionGuarantees, pgTransaction } from '@arki/lock/pg';
import type { PgLeasePollGuarantees, PgLeaseStore, PgLeaseWakeGuarantees } from '@arki/lock/pg/lease';
import type { RedisStore } from '@arki/lock/redis';
import { defineFeature, entrypointOnly } from '@arki/dot/feature';
import { defineApp, infra, service } from '@arki/dot/unit';
import { orThrow, UnexpectedDefect } from '@arki/failure';
import { createLocks, LockError, LockHeld } from '@arki/lock';
import { locks } from '@arki/lock/dot';
import { memoryStore } from '@arki/lock/memory';
import { manualScheduler } from '@arki/lock/testing';

import type { Locker, ScheduleDef } from './index.js';
import { lockSummary, schedule, schedules } from './dot.js';
import { defineSchedule } from './index.js';
import { createScheduleRuntime } from './runtime.js';

/** The real lock service on the memory store, with time under the test's control. */
function memoryLocks() {
  const clock = manualScheduler();
  return { clock, locks: createLocks({ store: memoryStore(), namespace: 'ns', scheduler: clock }) };
}

/** Let promise chains that need no timer run to their end. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
}

function buildApp(lockService: Locker) {
  let calls = 0;
  const seen: { signal?: AbortSignal; fence?: bigint | undefined } = {};
  const lockUnit = infra({ name: 'locks', provides: { locks: () => lockService } });
  // The handler never holds the lock: the scheduler takes it around the run. So the need is entrypoint-only.
  const core = defineFeature('clustering')
    .needs({ locks: entrypointOnly(lockUnit.provides.locks) })
    .usecases({
      assign: () => () => {
        calls += 1;
        return 'assigned';
      },
      broken: () => (): string => {
        throw new Error('handler broke');
      },
    });
  const clustering = core.entrypoints(
    schedules(core, [
      { name: 'cluster-assign', cron: '*/5 * * * *', lock: true, handler: ({ usecases }) => usecases.assign() },
      { name: 'cluster-batch', cron: '0 */4 * * *', lock: 'clusters', handler: ({ usecases }) => usecases.broken() },
      { name: 'cluster-trending', cron: '0 8 * * *', handler: () => 'unlocked' },
      { name: 'cluster-instant', cron: '0 9 * * *', lock: { holdAtLeast: 0 }, handler: () => 'instant' },
      { name: 'cluster-slow', cron: '0 10 * * *', lock: { key: 'slow-key', holdAtLeast: '5s' }, handler: () => 'slow' },
      {
        name: 'cluster-peek',
        cron: '0 11 * * *',
        lock: { holdAtLeast: 0 },
        handler: (_deps, run) => {
          seen.signal = run.lock?.signal;
          seen.fence = run.lock?.fence;
          return 'peeked';
        },
      },
    ]),
  );
  const app = defineApp('locks-app')
    .infra(lockUnit)
    .features([clustering])
    .entrypoints(schedule({ clock: 'host' }));
  return { app, seen, calls: () => calls };
}

describe('Locker', () => {
  it('accepts a real Locks of any store without a cast, so apps can pass what createLocks returns', () => {
    const memory = createLocks({ store: memoryStore(), namespace: 'n' });
    const locker: Locker = memory;
    expect(locker.namespace).toBe('n');
    expectTypeOf<Locks<MemoryStore>>().toExtend<Locker>();
    expectTypeOf<Locks<Store<PgSessionGuarantees>>>().toExtend<Locker>();
    expectTypeOf<Locks<Store>>().toExtend<Locker>();
    expectTypeOf<Locks<ReturnType<typeof pgTransaction>>>().toExtend<Locker>();
    expectTypeOf<Locks<PgLeaseStore<PgLeasePollGuarantees>>>().toExtend<Locker>();
    expectTypeOf<Locks<PgLeaseStore<PgLeaseWakeGuarantees>>>().toExtend<Locker>();
    expectTypeOf<Locks<RedisStore>>().toExtend<Locker>();
    expectTypeOf<Locks<FileStore>>().toExtend<Locker>();
  });
});

describe('schedules(core, [{ lock }])', () => {
  it('runs the handler inside the lock, keyed by the schedule name for `lock: true`', async () => {
    const { locks: service, clock } = memoryLocks();
    const { app, calls } = buildApp(service);
    const started = await orThrow(app.start());
    // `cluster-assign` holds 1 s by default: its run does not end before the clock moves.
    let finished = false;
    const assign = started.services.scheduler.trigger('cluster-assign').then(outcome => {
      finished = true;
      return outcome;
    });
    await settle();
    expect(calls()).toBe(1);
    expect(finished).toBe(false);
    await clock.advance('1s');
    await expect(assign).resolves.toEqual({ name: 'cluster-assign', status: 'ran', value: 'assigned' });
    await orThrow(started.dispose());
  });

  it('a held lock is skipped-lock, and the handler never starts', async () => {
    const { locks: service } = memoryLocks();
    const { app, calls } = buildApp(service);
    const started = await orThrow(app.start());
    const blocker = Promise.withResolvers<void>();
    const holding = service.mutex('cluster-assign').tryRun(() => blocker.promise);
    await settle();
    await expect(started.services.scheduler.trigger('cluster-assign')).resolves.toEqual({
      name: 'cluster-assign',
      status: 'skipped-lock',
    });
    expect(calls()).toBe(0);
    blocker.resolve();
    orThrow(await holding);
    await orThrow(started.dispose());
  });

  it('a lock that cannot be taken is lock-failed, not a silent skip', async () => {
    const broken: Locker = {
      mutex: () => ({
        tryRun: () => Promise.reject(new Error('connection lost')),
      }),
    };
    const { app, calls } = buildApp(broken);
    const started = await orThrow(app.start());
    await expect(started.services.scheduler.trigger('cluster-assign')).resolves.toMatchObject({
      status: 'lock-failed',
      cause: expect.objectContaining({ code: 'failure.unexpected_defect', cause: new Error('connection lost') }),
    });
    expect(calls()).toBe(0);
    await orThrow(started.dispose());
  });

  it('a handler that throws inside the lock is handler-failed, and the named key is used', async () => {
    const { locks: service, clock } = memoryLocks();
    const { app } = buildApp(service);
    const started = await orThrow(app.start());
    const run = started.services.scheduler.trigger('cluster-batch');
    await settle();
    // The named key is the one held, not the schedule name.
    await expect(service.mutex('clusters').tryRun(() => 1)).resolves.toMatchObject({ code: 'lock.held' });
    await clock.advance('1s');
    await expect(run).resolves.toMatchObject({
      status: 'handler-failed',
      cause: expect.objectContaining({
        code: UnexpectedDefect.code,
        cause: new Error('handler broke'),
      }),
    });
    await orThrow(started.dispose());
  });

  it('hands the handler the lock signal and fence, so a long job can stop when it loses the lock', async () => {
    const { locks: service } = memoryLocks();
    const { app, seen } = buildApp(service);
    const started = await orThrow(app.start());
    await started.services.scheduler.trigger('cluster-peek');
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(seen.signal?.aborted).toBe(false);
    expect(typeof seen.fence).toBe('bigint');
    await orThrow(started.dispose());
  });

  it('keeps the key for 1 s by default after a 10 ms job, so a replica with a slow clock cannot run the same tick again', async () => {
    const { locks: service, clock } = memoryLocks();
    const { app } = buildApp(service);
    const started = await orThrow(app.start());
    const run = started.services.scheduler.trigger('cluster-assign');
    await settle();
    await clock.advance('10ms');
    await expect(service.mutex('cluster-assign').tryRun(() => 'second replica')).resolves.toMatchObject({
      code: 'lock.held',
    });
    await clock.advance('989ms');
    await expect(service.mutex('cluster-assign').tryRun(() => 'second replica')).resolves.toMatchObject({
      code: 'lock.held',
    });
    await clock.advance('1ms');
    await expect(run).resolves.toMatchObject({ status: 'ran' });
    await expect(service.mutex('cluster-assign').tryRun(() => 'next tick')).resolves.toBe('next tick');
    await orThrow(started.dispose());
  });

  it('holdAtLeast: 0 frees the key as soon as the job ends, for jobs that must be able to run back to back', async () => {
    const { locks: service } = memoryLocks();
    const { app } = buildApp(service);
    const started = await orThrow(app.start());
    await expect(started.services.scheduler.trigger('cluster-instant')).resolves.toMatchObject({ status: 'ran' });
    await expect(service.mutex('cluster-instant').tryRun(() => 'next')).resolves.toBe('next');
    await orThrow(started.dispose());
  });

  it('shutdown waits through the hold, so a stopped app never frees a key early', async () => {
    const { locks: service, clock } = memoryLocks();
    const job = defineSchedule({ name: 'drain', every: '1h', handler: () => Promise.resolve() });
    const runtime = createScheduleRuntime({
      schedules: [{ ...job, lock: { key: 'drain', locks: service, holdAtLeastMs: 1000 } }],
    });
    const run = runtime.trigger('drain');
    await settle();
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    await clock.advance('1s');
    await stopping;
    expect(stopped).toBe(true);
    await expect(run).resolves.toMatchObject({ status: 'ran' });
  });

  it('shows the lock policy in the manifest, before anything runs', () => {
    const { locks: service } = memoryLocks();
    const { app } = buildApp(service);
    const actions = orThrow(app.configure()).manifest.actions;
    const find = (id: string) => actions.find(action => action.id === id);
    expect(find('cluster-assign.fire')?.meta).toMatchObject({
      locked: true,
      lock: 'cluster-assign',
      holdAtLeastMs: 1000,
    });
    expect(find('cluster-batch.fire')?.meta).toMatchObject({ locked: true, lock: 'clusters', holdAtLeastMs: 1000 });
    expect(find('cluster-instant.fire')?.meta).toMatchObject({ locked: true, holdAtLeastMs: 0 });
    expect(find('cluster-slow.fire')?.meta).toMatchObject({ locked: true, lock: 'slow-key', holdAtLeastMs: 5000 });
    expect(find('cluster-trending.fire')?.meta).toMatchObject({ locked: false });
    expect(find('cluster-trending.fire')?.meta).not.toHaveProperty('lock');
  });

  it('puts a one-line lock summary on locked actions and a warning on unlocked ones (host clock: overlapping triggers), so `dot explain` shows who can run twice', () => {
    const { locks: service } = memoryLocks();
    const { app } = buildApp(service);
    const actions = orThrow(app.configure()).manifest.actions;
    const summary = (id: string) => actions.find(action => action.id === id)?.summary;
    // The locker exists only at boot, so the declared text has the key and no store details.
    expect(summary('cluster-assign.fire')).toBe('lock cluster-assign');
    expect(summary('cluster-slow.fire')).toBe('lock slow-key');
    expect(summary('cluster-trending.fire')).toBe('NO LOCK — overlapping triggers can both run');
  });

  it('a lock without a `locks` service does not compile', () => {
    const bare = defineFeature('bare').usecases({ run: () => () => 1 });
    // @ts-expect-error the feature has no `locks` service
    schedules(bare, [{ name: 'job', every: '1m', lock: true, handler: ({ usecases }) => usecases.run() }]);
    // The object and string forms need it too.
    // @ts-expect-error no locks service
    schedules(bare, [{ name: 'a', every: '1m', lock: { holdAtLeast: 0 }, handler: ({ usecases }) => usecases.run() }]);
    // @ts-expect-error no locks service
    schedules(bare, [{ name: 'b', every: '1m', lock: 'k', handler: ({ usecases }) => usecases.run() }]);
    // @ts-expect-error no locks service
    schedules(bare, [{ name: 'c', every: '1m', lock: { key: 'k' }, handler: ({ usecases }) => usecases.run() }]);
    // A plain need is not enough: a `locks` the usecases could also read is not what the scheduler takes.
    const plain = defineFeature('plain')
      .needs({ locks: service<Locker>() })
      .usecases({ run: () => () => 1 });
    // @ts-expect-error a plain `locks` need is below the entrypoint; it must be `entrypointOnly`
    schedules(plain, [{ name: 'job', every: '1m', lock: true, handler: ({ usecases }) => usecases.run() }]);
    // Without `lock`, the same feature is fine.
    schedules(bare, [{ name: 'job', every: '1m', handler: ({ usecases }) => usecases.run() }]);
    expect(true).toBe(true);
  });

  it('a lock with a `locks` service from locks() of @arki/lock/dot works end to end', async () => {
    const lockPlugin = locks({ namespace: 'billing', store: () => memoryStore() });
    const needs = { locks: entrypointOnly(lockPlugin.provides.locks) };
    const billingCore = defineFeature('billing').needs(needs).usecases({});
    const billing = billingCore.entrypoints(
      schedules(billingCore, [{ name: 'bill', every: '1m', lock: { holdAtLeast: 0 }, handler: () => 'done' }]),
    );
    const started = await orThrow(
      defineApp('plugin-app')
        .infra(lockPlugin)
        .features([billing])
        .entrypoints(schedule({ clock: 'host' }))
        .start(),
    );
    await expect(started.services.scheduler.trigger('bill')).resolves.toEqual({
      name: 'bill',
      status: 'ran',
      value: 'done',
    });
    await orThrow(started.dispose());
  });
});

describe('lockSummary', () => {
  it('prints what the memory store promises, so a reader sees if a lock survives a crash or a second replica', () => {
    const { locks: service } = memoryLocks();
    expect(lockSummary({ key: 'job', holdAtLeastMs: 1000, locks: service })).toBe(
      'lock ns:job  [memory · hold · process · crash→immediate · fence process · hold≥1s]',
    );
  });

  it('leaves out the hold when it is 0, the namespace when absent and the bracket when no store is known', () => {
    const { locks: service } = memoryLocks();
    expect(lockSummary({ key: 'job', holdAtLeastMs: 0, locks: service })).toBe(
      'lock ns:job  [memory · hold · process · crash→immediate · fence process]',
    );
    expect(lockSummary({ key: 'job', holdAtLeastMs: 1000, locks: { mutex: key => service.mutex(key) } })).toBe(
      'lock job',
    );
  });

  it('prints fence none for a store that hands out no fence', () => {
    const noFence: Locker = {
      mutex: () => ({ tryRun: () => Promise.resolve(LockHeld({ waitedMs: 0 })) }),
      store: {
        name: 'redis',
        guarantees: { kind: 'lease', scope: 'cluster', fence: false, releasedOnCrash: 'ttl' },
      },
    };
    expect(lockSummary({ key: 'job', holdAtLeastMs: 1500, locks: noFence })).toBe(
      'lock job  [redis · lease · cluster · crash→ttl · fence none · hold≥1500ms]',
    );
  });
});

/** A schedule bound to `locker`; `trigger` it through a bare runtime. */
function lockedRuntime(locker: Locker, key = 'job') {
  const job: ScheduleDef = {
    ...defineSchedule({ name: 'job', every: '1h', handler: () => Promise.resolve('ok') }),
    lock: { key, locks: locker, holdAtLeastMs: 0 },
  };
  return createScheduleRuntime({ schedules: [job] });
}

const failingWith = (error: Error): Locker => ({ mutex: () => ({ tryRun: () => Promise.reject(error) }) });
const lockError = (code: 'lost' | 'release' | 'store') =>
  new LockError({ code, message: `${code} happened`, remediation: 'none' });

describe('lock counters', () => {
  it('a schedule bound with only a key still holds 1 s, so hand-built locks get the same clock-skew guard', async () => {
    const { locks: service, clock } = memoryLocks();
    const job: ScheduleDef = {
      ...defineSchedule({ name: 'job', every: '1h', handler: () => Promise.resolve('ok') }),
      lock: { key: 'job', locks: service },
    };
    const runtime = createScheduleRuntime({ schedules: [job] });
    const run = runtime.trigger('job');
    await settle();
    await expect(service.mutex('job').tryRun(() => 1)).resolves.toMatchObject({ code: 'lock.held' });
    await clock.advance('1s');
    await expect(run).resolves.toMatchObject({ status: 'ran' });
  });

  it('counts contention apart from failures, so a busy peer does not look like an outage', async () => {
    const { locks: service } = memoryLocks();
    const runtime = lockedRuntime(service);
    const blocker = Promise.withResolvers<void>();
    const holding = service.mutex('job').tryRun(() => blocker.promise);
    await settle();
    await expect(runtime.trigger('job')).resolves.toEqual({ name: 'job', status: 'skipped-lock' });
    blocker.resolve();
    orThrow(await holding);
    expect(runtime).toMatchObject({ lockContention: 1, lockFailures: 0, lockLost: 0 });
  });

  it('counts a store failure as a failure, so an outage is never hidden as a held lock', async () => {
    const runtime = lockedRuntime(failingWith(lockError('store')));
    await expect(runtime.trigger('job')).resolves.toMatchObject({ status: 'lock-failed' });
    expect(runtime).toMatchObject({ lockContention: 0, lockFailures: 1, lockLost: 0 });
  });

  it('counts a lost lock on its own, because the handler may have had side effects while another replica ran', async () => {
    const runtime = lockedRuntime(failingWith(lockError('lost')));
    await expect(runtime.trigger('job')).resolves.toMatchObject({ status: 'lock-failed' });
    expect(runtime).toMatchObject({ lockContention: 0, lockFailures: 0, lockLost: 1 });
  });
});

/** A memory store whose grants can be lost on demand, as a dropped database connection would. */
function losableStore() {
  const inner = memoryStore();
  let loseNow: (() => void) | undefined;
  const store: Store = {
    name: inner.name,
    guarantees: { ...inner.guarantees, permits: false, shared: false },
    async acquire(key: Key, request) {
      const grant = await inner.acquire(key, request);
      if (grant === undefined) return grant;
      const lost = new Promise<LockError>(resolve => {
        loseNow = () => resolve(lockError('lost'));
      });
      const losable: Grant = { ...grant, lost };
      return losable;
    },
    release: grant => inner.release(grant),
  };
  return { store, lose: () => loseNow?.() };
}

function runtimeOver(locker: Locker, handler: () => Promise<unknown>) {
  const job: ScheduleDef = {
    ...defineSchedule({ name: 'job', every: '1h', handler }),
    lock: { key: 'job', locks: locker },
  };
  return createScheduleRuntime({ schedules: [job] });
}

describe('lock lost after the handler finished', () => {
  it('keeps the handler outcome and counts the loss, because the work is done even if another replica may rerun the tick', async () => {
    const clock = manualScheduler();
    const { store, lose } = losableStore();
    const runtime = runtimeOver(createLocks({ store, namespace: 'ns', scheduler: clock }), () => Promise.resolve('ok'));
    const run = runtime.trigger('job');
    await settle();
    lose();
    await settle();
    await clock.advance('1s');
    await expect(run).resolves.toEqual({ name: 'job', status: 'ran', value: 'ok' });
    expect(runtime).toMatchObject({ lockLost: 1, lockFailures: 0, handlerFailures: 0 });
  });

  it('a throwing handler still holds the key for the whole hold, so a skewed replica cannot start the same tick', async () => {
    const { locks: service, clock } = memoryLocks();
    const runtime = runtimeOver(service, () => Promise.reject(new Error('boom')));
    const run = runtime.trigger('job');
    await settle();
    await expect(service.mutex('job').tryRun(() => 1)).resolves.toMatchObject({ code: 'lock.held' });
    await clock.advance('1s');
    await expect(run).resolves.toMatchObject({ status: 'handler-failed' });
    await expect(service.mutex('job').tryRun(() => 1)).resolves.toBe(1);
  });
});

const summaryOf = (actions: readonly { id: string; summary?: string }[]) =>
  actions.find(action => action.id === 'job.fire')?.summary;

describe('booted lock summary', () => {
  it('shows the whole lock line after boot, once the store is known, and keeps the short line in the static manifest', async () => {
    const lockPlugin = locks({ namespace: 'ns', store: () => memoryStore() });
    const needs = { locks: entrypointOnly(lockPlugin.provides.locks) };
    const billingCore = defineFeature('billing').needs(needs).usecases({});
    const billing = billingCore.entrypoints(
      schedules(billingCore, [{ name: 'job', every: '1m', lock: true, handler: () => 'done' }]),
    );
    const configured = orThrow(
      defineApp('boot-summary')
        .infra(lockPlugin)
        .features([billing])
        .entrypoints(schedule({ clock: 'host' }))
        .configure(),
    );
    const staticSummary = summaryOf(configured.manifest.actions);
    const booted = await orThrow(configured.boot());
    expect(staticSummary).toBe('lock job');
    expect(summaryOf(booted.manifest.actions)).toBe(
      'lock ns:job  [memory · hold · process · crash→immediate · fence process · hold≥1s]',
    );
    await orThrow(booted.dispose());
  });
});
