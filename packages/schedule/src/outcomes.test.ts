import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { defineFeature } from '@arki/dot/feature';
import { defineApp } from '@arki/dot/unit';
import { defineFailure, orThrow, UnexpectedDefect } from '@arki/failure';
import { createLocks } from '@arki/lock';
import { memoryStore } from '@arki/lock/memory';

import type { DurableScheduleRegistration } from './runtime.js';
import { composeSchedules, schedule, schedules } from './dot.js';
import { defineSchedule, initSchedule, ScheduleLockFailed } from './index.js';
import { createScheduleRuntime } from './runtime.js';

const Refused = defineFailure('schedule.report_refused', {
  status: 409,
  data: z.object({ reason: z.string() }),
  message: 'Report refused: {reason}',
});
const DifferentRefusal = defineFailure('schedule.different_refusal', { status: 403 });

describe('business outcomes', () => {
  it('preserves failure identity and counts a refusal without ever reporting ran', async () => {
    const refusal = Refused({ reason: 'not due' });
    let refuse = true;
    const report = defineSchedule({
      name: 'report',
      every: '1h',
      handler: () => Promise.resolve(refuse ? refusal : { sent: 3 }),
    });
    const other = defineSchedule({ name: 'other', every: '1h', handler: () => Promise.resolve(DifferentRefusal()) });
    const runtime = createScheduleRuntime({ schedules: [report, other], clock: 'host' });

    const rejected = await runtime.trigger('report');
    expect(rejected).toEqual({ name: 'report', status: 'refused', failure: refusal });
    if (rejected.status === 'refused') {
      expect(rejected.failure).toBe(refusal);
      expectTypeOf(rejected.failure).toEqualTypeOf<typeof refusal>();
    }
    expect(runtime.handlerFailures).toBe(1);
    expect(runtime.lockFailures).toBe(0);
    refuse = false;
    const accepted = await runtime.trigger('report');
    if (accepted.status === 'ran') expectTypeOf(accepted.value).toEqualTypeOf<{ sent: number }>();
    expect(accepted).toEqual({ name: 'report', status: 'ran', value: { sent: 3 } });
    expect(runtime.handlerFailures).toBe(1);
    await runtime.stop();
  });

  it('infers context builders and never widens a definition to other schedules failures', async () => {
    const builder = initSchedule.context<{ readonly allowed: boolean }>().create();
    const refusal = Refused({ reason: 'disabled' });
    const report = builder.define({
      name: 'context-report',
      every: '1h',
      handler: ({ allowed }) => Promise.resolve(allowed ? 7 : refusal),
    });
    const runtime = createScheduleRuntime({ schedules: [report], createContext: () => ({ allowed: false }) });
    const result = await runtime.trigger('context-report');
    if (result.status === 'refused') expectTypeOf(result.failure).toEqualTypeOf<typeof refusal>();
    if (result.status === 'ran') expectTypeOf(result.value).toEqualTypeOf<number>();
    expect(result.status).toBe('refused');
    await runtime.stop();
  });

  it('infers every feature, including handlers that require the run argument', async () => {
    const refusal = Refused({ reason: 'feature disabled' });
    const runCore = defineFeature('run-report');
    const runFeature = runCore.entrypoints(
      schedules(runCore, [{ name: 'object', every: '1h', handler: (_ctx, run) => (run.lock ? 1 : refusal) }]),
    );
    const core = defineFeature('chain-report');
    const chain = core.entrypoints(
      schedules(core, [{ name: 'chain', every: '1h', handler: () => DifferentRefusal() }]),
    );
    const app = await orThrow(
      defineApp('typed-failures')
        .features([runFeature, chain])
        .entrypoints(schedule({ clock: 'host' }))
        .boot(),
    );
    const client = composeSchedules([runFeature, chain], app.services.scheduler);
    const result = await client.trigger('object');
    if (result.status === 'refused') expectTypeOf(result.failure).toEqualTypeOf<typeof refusal>();
    if (result.status === 'ran') expectTypeOf(result.value).toEqualTypeOf<number>();
    expect(result).toEqual({ name: 'object', status: 'refused', failure: refusal });
    const other = await client.trigger('chain');
    if (other.status === 'refused') expectTypeOf(other.failure).toEqualTypeOf<ReturnType<typeof DifferentRefusal>>();
    expect(other.status).toBe('refused');
    await orThrow(app.dispose());
  });

  it('infers legacy definition-list slices from the definitions the runtime executes', async () => {
    const refusal = Refused({ reason: 'legacy' });
    const report = defineSchedule({ name: 'legacy', every: '1h', handler: () => Promise.resolve(refusal) });
    const reports = defineFeature('legacy-report').entrypoints(schedules([report]));
    const app = await orThrow(
      defineApp('legacy')
        .features([reports])
        .entrypoints(schedule({ clock: 'host' }))
        .boot(),
    );
    const result = await composeSchedules([reports], app.services.scheduler).trigger('legacy');
    if (result.status === 'refused') expectTypeOf(result.failure).toEqualTypeOf<typeof refusal>();
    if (result.status === 'ran') expectTypeOf(result.value).toEqualTypeOf<never>();
    expect(result).toEqual({ name: 'legacy', status: 'refused', failure: refusal });
    await orThrow(app.dispose());
  });

  it('passes refusals unchanged to the durable backend and still drains shutdown', async () => {
    const refusal = Refused({ reason: 'durable refusal' });
    const registrations: DurableScheduleRegistration[] = [];
    const report = defineSchedule({
      name: 'durable-refusal',
      every: '1h',
      durable: true,
      handler: () => Promise.resolve(refusal),
    });
    const runtime = createScheduleRuntime({
      schedules: [report],
      durable: {
        start: defs => {
          registrations.push(...defs);
          return Promise.resolve();
        },
        stop: () => Promise.resolve(),
      },
    });
    runtime.start();
    const registration = registrations[0];
    expect(registration).toBeDefined();
    expect(await registration?.run()).toEqual({ name: 'durable-refusal', status: 'refused', failure: refusal });
    expect(runtime.handlerFailures).toBe(1);
    await runtime.stop();
    expect(await registration?.run()).toEqual({ name: 'durable-refusal', status: 'unavailable' });
  });

  it('keeps locked business refusals distinct from lock contention and releases the lock', async () => {
    const refusal = Refused({ reason: 'locked refusal' });
    const locks = createLocks({ store: memoryStore(), namespace: 'outcomes' });
    const definition = {
      ...defineSchedule({ name: 'locked', every: '1h', handler: () => Promise.resolve(refusal) }),
      lock: { key: 'reports', locks, holdAtLeastMs: 0 },
    };
    const runtime = createScheduleRuntime({ schedules: [definition] });
    await expect(runtime.trigger('locked')).resolves.toEqual({ name: 'locked', status: 'refused', failure: refusal });
    await expect(runtime.trigger('locked')).resolves.toMatchObject({ status: 'refused' });
    expect(runtime.handlerFailures).toBe(2);
    expect(runtime.lockContention).toBe(0);
    expect(runtime.lockFailures).toBe(0);
    await runtime.stop();
  });

  it('classifies only known lock provider codes and keeps arbitrary diagnostic text private', async () => {
    for (const code of [...ScheduleLockFailed.dataSchema.shape.lockCode.options, 'private-unrecognized-code']) {
      const error = Object.assign(new Error('private store detail'), { code });
      const report = {
        ...defineSchedule({ name: 'locked', every: '1h', handler: () => Promise.resolve(1) }),
        lock: { key: 'private-lock-key', locks: { mutex: () => ({ tryRun: () => Promise.reject(error) }) } },
      };
      const runtime = createScheduleRuntime({ schedules: [report] });
      const result = await runtime.trigger('locked');
      expect(result.status).toBe('lock-failed');
      if (result.status !== 'lock-failed') throw new Error('expected a lock failure');
      expect(result.cause.cause).toBe(error);
      expect(ScheduleLockFailed.is(result.cause)).toBe(code !== 'private-unrecognized-code');
      for (const secret of ['private-lock-key', 'private-unrecognized-code', 'private store detail']) {
        expect(JSON.stringify(result)).not.toContain(secret);
      }
      expect(runtime.handlerFailures).toBe(0);
      expect(runtime.lockLost + runtime.lockFailures).toBe(1);
      await runtime.stop();
    }
  });

  it('keeps returned defects and thrown defects from masquerading as success', async () => {
    const defect = UnexpectedDefect({ cause: new Error('private cause') });
    const returned = defineSchedule({ name: 'returned', every: '1h', handler: () => Promise.resolve(defect) });
    const thrown = defineSchedule({ name: 'thrown', every: '1h', handler: () => Promise.reject(new Error('defect')) });
    const runtime = createScheduleRuntime({ schedules: [returned, thrown] });
    await expect(runtime.trigger('returned')).resolves.toEqual({
      name: 'returned',
      status: 'handler-failed',
      cause: defect,
    });
    await expect(runtime.trigger('thrown')).resolves.toMatchObject({ status: 'handler-failed' });
    expect(runtime.handlerFailures).toBe(2);
    await runtime.stop();
  });
});
