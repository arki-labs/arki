import { describe, expect, it } from 'vitest';

import { defineApp } from '@arki/dot';

import { schedule, scheduleActions } from './dot.js';
import { ScheduleError, SCHEDULE_ERROR_CODES, defineSchedule } from './index.js';
import { project } from './projection.js';
import { createScheduleRuntime, type KvLike } from './runtime.js';

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
});

describe('schedule DOT projection', () => {
  it('declares schedule actions and registers the schedule-table projection', () => {
    const daily = defineSchedule({
      name: 'daily-maintenance',
      cron: '0 2 * * *',
      timezone: 'UTC',
      handler: async () => {},
    });
    const app = defineApp('schedule-app').use(schedule({ schedules: [daily], lock: lockThat(true) })).configure();

    expect(app.manifest.actions).toEqual([
      {
        id: 'daily-maintenance.fire',
        pip: 'schedule',
        binding: 'schedule',
        direction: 'in',
        address: '0 2 * * *',
        metaSchema: '@arki/schedule/action-meta@1',
        meta: {
          kind: 'cron',
          cron: '0 2 * * *',
          timezone: 'UTC',
          overlap: 'skip',
          locked: true,
        },
      },
    ]);
    expect(app.manifest.projections).toEqual([
      {
        format: 'schedule-table',
        binding: 'schedule',
        module: '@arki/schedule/projection',
        pip: 'schedule',
      },
    ]);
  });

  it('projects the recurring surface from schedule actions', () => {
    const hourly = defineSchedule({
      name: 'hourly-sync',
      every: '1h',
      overlap: 'concurrent',
      handler: async () => {},
    });
    const actions = scheduleActions([hourly]).map(action => ({ ...action, pip: 'schedule' }));

    expect(project({ app: { name: 'schedule-app' }, actions })).toEqual({
      format: 'schedule-table',
      schedules: [
        {
          id: 'hourly-sync.fire',
          name: 'hourly-sync',
          pip: 'schedule',
          kind: 'every',
          address: '1h',
          overlap: 'concurrent',
          locked: false,
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

  it('skips when another replica owns the lock', async () => {
    const calls: string[] = [];
    const locked = defineSchedule({
      name: 'locked',
      every: '1h',
      handler: async () => {
        calls.push('handler');
      },
    });
    const runtime = createScheduleRuntime({ schedules: [locked], lock: lockThat(false) });

    await expect(runtime.trigger('locked')).resolves.toEqual({ name: 'locked', status: 'skipped-lock' });
    expect(runtime.lockSkips).toBe(1);
    expect(calls).toEqual([]);
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

    await expect(runtime.trigger('failing')).resolves.toEqual({ name: 'failing', status: 'handler-failed' });
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

function lockThat(acquired: boolean): KvLike {
  return {
    async setIfNotExists() {
      return acquired;
    },
  };
}
