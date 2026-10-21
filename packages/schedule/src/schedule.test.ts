import { describe, expect, it } from 'vitest';

import { feature } from '@arki/dot/feature';
import { defineApp, infra, service } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';

import type { DurableScheduler, DurableScheduleRegistration } from './runtime.js';
import { DurableSchedules, schedule, scheduleActions, schedules } from './dot.js';
import { defineSchedule, initSchedule, SCHEDULE_ERROR_CODES, ScheduleError } from './index.js';
import { project } from './projection.js';
import { createScheduleRuntime } from './runtime.js';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('defineSchedule', () => {
  it('rejects invalid cron expressions at construction time', () => {
    expect(() =>
      defineSchedule({
        name: 'bad-cron',
        cron: 'not cron',
        handler: async () => {},
      }),
    ).toThrow(ScheduleError);
  });

  it('rejects every intervals that are not positive s/m/h values', () => {
    expect(() =>
      defineSchedule({
        name: 'bad-every',
        every: '0s',
        handler: async () => {},
      }),
    ).toThrow(ScheduleError);
  });

  it('creates context-typed schedules through initSchedule', async () => {
    const s = initSchedule.context<{ readonly db: { readonly ping: () => string } }>().create();
    const observed: string[] = [];
    const typed = s.define({
      name: 'typed',
      every: '1h',
      handler: async ctx => {
        observed.push(ctx.db.ping());
      },
    });
    const runtime = createScheduleRuntime({
      schedules: [typed],
      createContext: () => ({ db: { ping: () => 'ok' } }),
    });

    await expect(runtime.trigger('typed')).resolves.toEqual({ name: 'typed', status: 'ran' });
    expect(observed).toEqual(['ok']);
  });
});

describe('schedule DOT projection', () => {
  it('declares schedule actions and registers the schedule-table projection', () => {
    const daily = defineSchedule({
      name: 'daily-maintenance',
      cron: '0 2 * * *',
      timezone: 'UTC',
      handler: async () => {},
    });
    const app = orThrow(
      defineApp('schedule-app')
        .entrypoints(schedule({ schedules: [daily] }))
        .configure(),
    );

    expect(app.manifest.actions).toEqual([
      {
        id: 'daily-maintenance.fire',
        plugin: 'schedule',
        binding: 'schedule',
        direction: 'in',
        address: '0 2 * * *',
        metaSchema: '@arki/schedule/action-meta@1',
        meta: {
          kind: 'cron',
          cron: '0 2 * * *',
          timezone: 'UTC',
          overlap: 'skip',
          locked: false,
          durable: false,
        },
        summary: 'NO LOCK — runs on every replica',
      },
    ]);
    expect(app.manifest.projections).toEqual([
      {
        format: 'schedule-table',
        binding: 'schedule',
        module: '@arki/schedule/projection',
        plugin: 'schedule',
      },
    ]);
  });

  // The point of a driver: the app lists its features once, in
  // `.features()`, and `.entrypoints(schedule())` runs their schedules. A second
  // list inside schedule() would drift from the first.
  it('runs the schedules of every mounted feature with the app context, without listing them again', async () => {
    type ScheduleCtx = { readonly dependencyName: string };
    const s = initSchedule.context<ScheduleCtx>().create();
    const calls: string[] = [];
    // Durable so the test can fire the tick through the fake backend.
    const daily = s.define({
      name: 'feature-daily',
      every: '1h',
      durable: true,
      handler: async ctx => {
        calls.push(ctx.dependencyName);
      },
    });
    const reports = feature('reports', { use: [schedules([daily])] });
    // A feature with no schedules is skipped, not an error.
    const quiet = feature('quiet', {});
    const fake = fakeDurableScheduler();
    const dependency = infra({ name: 'dependency', provides: { dependency: () => ({ name: 'dep' }) } });
    const backend = infra({ name: 'durable-backend', provides: { [DurableSchedules.key]: () => fake } });

    const app = await orThrow(
      defineApp('schedule-feature')
        .infra(dependency)
        .infra(backend)
        .features([reports, quiet])
        .entrypoints(
          schedule({
            needs: { dependency: service<{ readonly name: string }>() },
            context: ({ dependency: dep }) => ({ dependencyName: dep.name }),
            durable: DurableSchedules,
          }),
        )
        .boot(),
    );

    // Schedule actions belong to the feature; the driver declares none of its own.
    expect(app.manifest.actions.map(action => `${action.plugin}:${action.id}`)).toEqual(['reports:feature-daily.fire']);
    await orThrow(app.start());
    await expect(registration(fake, 'feature-daily').run()).resolves.toEqual({ name: 'feature-daily', status: 'ran' });
    expect(calls).toEqual(['dep']);
    await orThrow(app.stop());
    await orThrow(app.dispose());
  });

  it('runs feature and app-level schedules on one runtime, so their names must not clash', async () => {
    const plain = defineSchedule({ name: 'shared-name', every: '1h', handler: () => Promise.resolve() });
    const owner = feature('owner', { use: [schedules([plain])] });

    await expect(
      defineApp('schedule-clash')
        .features([owner])
        .entrypoints(schedule({ schedules: [plain] }))
        .boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: { code: SCHEDULE_ERROR_CODES.duplicateSchedule },
    });
  });

  it('fails boot with a coded error when a feature publishes a schedules slice that is not a schedule list', async () => {
    const broken = feature('broken', { use: [{ key: 'schedules', actions: [], resolve: () => ({ not: 'a list' }) }] });

    await expect(defineApp('schedule-broken').features([broken]).entrypoints(schedule({})).boot()).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: { code: SCHEDULE_ERROR_CODES.invalidDefinition },
    });
  });

  it('projects the recurring surface from schedule actions', () => {
    const hourly = defineSchedule({
      name: 'hourly-sync',
      every: '1h',
      overlap: 'concurrent',
      handler: async () => {},
    });
    const actions = scheduleActions([hourly]).map(action => ({ ...action, plugin: 'schedule' }));

    expect(project({ app: { name: 'schedule-app' }, actions })).toEqual({
      format: 'schedule-table',
      schedules: [
        {
          id: 'hourly-sync.fire',
          name: 'hourly-sync',
          plugin: 'schedule',
          kind: 'every',
          address: '1h',
          overlap: 'concurrent',
          locked: false,
          durable: false,
        },
      ],
    });
  });
});

describe('schedule runtime', () => {
  it('rejects duplicate schedule names', () => {
    const first = defineSchedule({ name: 'same', every: '1h', handler: async () => {} });
    const second = defineSchedule({ name: 'same', every: '1h', handler: async () => {} });

    try {
      createScheduleRuntime({ schedules: [first, second] });
      throw new Error('Expected duplicate schedule names to throw.');
    } catch (error) {
      expect(error).toMatchObject({ code: SCHEDULE_ERROR_CODES.duplicateSchedule });
    }
  });

  it('skips overlapping runs by default', async () => {
    const gate = deferred();
    const slow = defineSchedule({
      name: 'slow',
      every: '1h',
      handler: async () => gate.promise,
    });
    const runtime = createScheduleRuntime({ schedules: [slow] });

    const first = runtime.trigger('slow');
    await Promise.resolve();
    const second = await runtime.trigger('slow');
    gate.resolve();

    await expect(first).resolves.toEqual({ name: 'slow', status: 'ran' });
    expect(second).toEqual({ name: 'slow', status: 'skipped-overlap' });
  });

  it('counts handler failures without throwing out of the timer loop', async () => {
    const failing = defineSchedule({
      name: 'failing',
      every: '1h',
      handler: async () => {
        throw new Error('boom');
      },
    });
    const runtime = createScheduleRuntime({ schedules: [failing] });

    await expect(runtime.trigger('failing')).resolves.toEqual({
      name: 'failing',
      status: 'handler-failed',
      cause: expect.objectContaining({ code: 'failure.unexpected_defect', cause: new Error('boom') }),
    });
    expect(runtime.handlerFailures).toBe(1);
  });

  it('stop waits for in-flight handlers to drain', async () => {
    const gate = deferred();
    const events: string[] = [];
    const slow = defineSchedule({
      name: 'drain',
      every: '1h',
      handler: async () => {
        events.push('started');
        await gate.promise;
        events.push('finished');
      },
    });
    const runtime = createScheduleRuntime({ schedules: [slow] });
    const run = runtime.trigger('drain');
    await Promise.resolve();

    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.resolve();

    await stopping;
    await expect(run).resolves.toEqual({ name: 'drain', status: 'ran' });
    expect(events).toEqual(['started', 'finished']);
    expect(stopped).toBe(true);
  });
});

type FakeDurableScheduler = DurableScheduler & {
  readonly registered: DurableScheduleRegistration[];
  readonly stops: number;
};

// In-memory stand-in for the BullMQ backend: records what the runtime hands
// over so a test can fire a tick by calling the registration's `run`.
function fakeDurableScheduler(): FakeDurableScheduler {
  const registered: DurableScheduleRegistration[] = [];
  let stops = 0;
  return {
    registered,
    get stops() {
      return stops;
    },
    async start(schedules) {
      registered.push(...schedules);
    },
    async stop() {
      stops += 1;
    },
  };
}

function registration(fake: FakeDurableScheduler, name: string): DurableScheduleRegistration {
  const found = fake.registered.find(entry => entry.name === name);
  if (found === undefined) throw new Error(`Expected durable schedule "${name}" to be registered.`);
  return found;
}

describe('durable schedules', () => {
  it('defaults to in-process and records durable: true on the definition', () => {
    const plain = defineSchedule({ name: 'plain', every: '1h', handler: async () => {} });
    const durable = defineSchedule({ name: 'nightly', cron: '0 3 * * *', durable: true, handler: async () => {} });

    expect(plain.durable).toBe(false);
    expect(durable.durable).toBe(true);
  });

  it('rejects a durable name with ":" at declaration, because the backend uses it as a queue name', () => {
    try {
      defineSchedule({ name: 'billing:nightly', cron: '0 3 * * *', durable: true, handler: async () => {} });
      throw new Error('Expected a durable name with ":" to throw.');
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduleError);
      expect((error as ScheduleError).code).toBe(SCHEDULE_ERROR_CODES.invalidDefinition);
    }
    expect(() => defineSchedule({ name: 'billing:nightly', cron: '0 3 * * *', handler: async () => {} })).not.toThrow();
  });

  it('hands durable schedules to the backend and keeps the rest on in-process timers', async () => {
    const fake = fakeDurableScheduler();
    const nightly = defineSchedule({
      name: 'nightly',
      cron: '0 3 * * *',
      timezone: 'UTC',
      durable: true,
      handler: async () => {},
    });
    const sweep = defineSchedule({ name: 'sweep', every: '5m', durable: true, handler: async () => {} });
    const local = defineSchedule({ name: 'local', every: '1h', handler: async () => {} });
    const runtime = createScheduleRuntime({ schedules: [nightly, sweep, local], durable: fake });

    runtime.start();
    await runtime.stop();

    expect(fake.registered.map(({ run: _run, ...rest }) => rest)).toEqual([
      { name: 'nightly', cron: '0 3 * * *', timezone: 'UTC' },
      { name: 'sweep', everyMs: 300_000 },
    ]);
    expect(fake.stops).toBe(1);
  });

  it('a durable tick runs the handler with the schedule context and skips the lock', async () => {
    const fake = fakeDurableScheduler();
    const seen: string[] = [];
    const s = initSchedule.context<{ readonly tenant: string }>().create();
    const nightly = s.define({
      name: 'nightly',
      cron: '0 3 * * *',
      durable: true,
      handler: async ctx => {
        seen.push(ctx.tenant);
      },
    });
    // Durable runs reach one worker through the backend and take no lock.
    const runtime = createScheduleRuntime({
      schedules: [nightly],
      durable: fake,
      createContext: () => ({ tenant: 'acme' }),
    });

    runtime.start();
    await expect(registration(fake, 'nightly').run()).resolves.toEqual({ name: 'nightly', status: 'ran' });
    expect(seen).toEqual(['acme']);
    expect(runtime.lockContention).toBe(0);
    await runtime.stop();
  });

  it('a failing durable handler reports handler-failed like an in-process run', async () => {
    const fake = fakeDurableScheduler();
    const failing = defineSchedule({
      name: 'failing',
      every: '1m',
      durable: true,
      handler: async () => {
        throw new Error('boom');
      },
    });
    const runtime = createScheduleRuntime({ schedules: [failing], durable: fake });

    runtime.start();
    await expect(registration(fake, 'failing').run()).resolves.toEqual({
      name: 'failing',
      status: 'handler-failed',
      cause: expect.objectContaining({ code: 'failure.unexpected_defect', cause: new Error('boom') }),
    });
    expect(runtime.handlerFailures).toBe(1);
    await runtime.stop();
  });

  it('a bare runtime with a durable schedule and no backend fails at start with a coded error', () => {
    const nightly = defineSchedule({ name: 'nightly', cron: '0 3 * * *', durable: true, handler: async () => {} });
    const runtime = createScheduleRuntime({ schedules: [nightly] });

    try {
      runtime.start();
      throw new Error('Expected start to throw.');
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduleError);
      expect((error as ScheduleError).code).toBe(SCHEDULE_ERROR_CODES.durableBackendMissing);
      expect((error as ScheduleError).message).toContain('"nightly"');
      expect((error as ScheduleError).remediation).toContain('durableScheduler');
    }
  });

  it('the Dot unit fails boot with a coded error when a durable schedule has no backend', async () => {
    const nightly = defineSchedule({ name: 'nightly', cron: '0 3 * * *', durable: true, handler: async () => {} });

    await expect(
      defineApp('durable-missing')
        .entrypoints(schedule({ schedules: [nightly] }))
        .boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: { code: SCHEDULE_ERROR_CODES.durableBackendMissing },
    });
  });

  it('the Dot unit fails boot for a durable feature schedule too, naming the schedule', async () => {
    const nightly = defineSchedule({ name: 'feature-nightly', every: '1h', durable: true, handler: async () => {} });
    const durableFeature = feature('durable-feature', { use: [schedules([nightly])] });

    await expect(
      defineApp('durable-missing-feature').features([durableFeature]).entrypoints(schedule({})).boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: {
        code: SCHEDULE_ERROR_CODES.durableBackendMissing,
        message: expect.stringContaining('"feature-nightly"'),
      },
    });
  });

  it('the Dot unit takes the backend as a typed need and hands it the durable schedules at start', async () => {
    const fake = fakeDurableScheduler();
    const backend = infra({ name: 'durable-backend', provides: { [DurableSchedules.key]: () => fake } });
    const calls: string[] = [];
    const nightly = defineSchedule({
      name: 'nightly',
      cron: '0 3 * * *',
      durable: true,
      handler: async () => {
        calls.push('nightly');
      },
    });
    const app = await orThrow(
      defineApp('durable-app')
        .infra(backend)
        .entrypoints(schedule({ schedules: [nightly], durable: DurableSchedules }))
        .boot(),
    );

    await orThrow(app.start());
    await expect(registration(fake, 'nightly').run()).resolves.toEqual({ name: 'nightly', status: 'ran' });
    expect(calls).toEqual(['nightly']);
    expect(app.manifest.actions[0]?.meta).toMatchObject({ durable: true });
    await orThrow(app.stop());
    expect(fake.stops).toBe(1);
    await orThrow(app.dispose());
  });

  it('requires a mounted backend at the type level once durable is passed', () => {
    const nightly = defineSchedule({ name: 'nightly', cron: '0 3 * * *', durable: true, handler: async () => {} });

    // @ts-expect-error schedule({ durable: DurableSchedules }) needs an infra unit that provides DurableSchedules.
    defineApp('durable-no-backend').entrypoints(schedule({ schedules: [nightly], durable: DurableSchedules }));
    // @ts-expect-error durable takes the DurableSchedules token, not a boolean.
    schedule({ schedules: [nightly], durable: true });
  });
});
