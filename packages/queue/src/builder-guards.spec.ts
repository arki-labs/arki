/**
 * Declaration guards for the job, schedule and flow builders.
 *
 * Each mistake is caught twice: the `@ts-expect-error` lines fail
 * `bun run typecheck` if the compile-time guard stops firing (this file is
 * listed under `files` in tsconfig.json for that reason), and the runtime
 * assertions prove the coded-error backstop still throws for plain JS and casts.
 * No Redis needed: nothing here registers or runs a job.
 */

import { describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';

import { CronPatterns } from './cron-patterns.ts';
import { QUEUE_DEFINITION_ERROR_CODES, QueueDefinitionError } from './errors.ts';
import { initQueue } from './init.ts';

type TestContext = { userId: string };

const q = initQueue.context<TestContext>().create();

/** Run `fn`, and return the error it threw (fails the test when nothing throws). */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the declaration to throw');
}

function expectCode(error: unknown, code: QueueDefinitionError['code']): void {
  expect(error).toBeInstanceOf(QueueDefinitionError);
  expect(error).toMatchObject({ name: 'QueueDefinitionError', code });
  expect(error instanceof QueueDefinitionError && error.remediation.length > 0).toBe(true);
}

/** A flow step job. */
const stepJob = q.job
  .name('guards:step')
  .input(z.object({}))
  .handler(() => Promise.resolve());

describe('job builder guards', () => {
  it('.handler() before .input() is a compile error and throws missingInput', () => {
    const named = q.job.name('guards:job');
    const error = thrown(() =>
      // @ts-expect-error -- `.handler()` does not exist until `.input()` runs
      named.handler(() => Promise.resolve({ ok: true })),
    );
    expectCode(error, QUEUE_DEFINITION_ERROR_CODES.missingInput);
    expect(error).toHaveProperty('message', 'Input schema is required. Call .input() before .handler().');
  });

  it('.handler() after .options() but before .input() is still a compile error', () => {
    const withOptions = q.job.name('guards:job').options({ maxParallelism: 1 });
    expectCode(
      // @ts-expect-error -- `.options()` does not unlock `.handler()`
      thrown(() => withOptions.handler(() => Promise.resolve({ ok: true }))),
      QUEUE_DEFINITION_ERROR_CODES.missingInput,
    );
  });

  it('.handler() before .name() is a compile error', () => {
    // @ts-expect-error -- the unnamed job builder has no `.handler()`
    expect(q.job.handler).toBeUndefined();
  });

  it('builds once .name() and .input() ran, with .options() before or after .input()', () => {
    const optionsFirst = q.job
      .name('guards:options-first')
      .options({ maxParallelism: 1 })
      .input(z.object({ id: z.string() }))
      .handler(data => Promise.resolve({ id: data.id }));
    const optionsLast = q.job
      .use(q.middleware(({ next }) => next()))
      .name('guards:options-last')
      .input(z.object({ id: z.string() }))
      .options({ maxParallelism: 1 })
      .handler((data, ctx) => Promise.resolve({ id: data.id, userId: ctx.userId }));

    expect(optionsFirst._internal.name).toBe('guards:options-first');
    expect(optionsLast._internal.options).toEqual({ maxParallelism: 1 });
  });
});

describe('schedule builder guards', () => {
  it('.handler() before .input() is a compile error and throws missingInput', () => {
    const named = q.schedule.everyMinutes(5).name('guards:schedule');
    expectCode(
      // @ts-expect-error -- `.handler()` does not exist until `.input()` runs
      thrown(() => named.handler(() => Promise.resolve())),
      QUEUE_DEFINITION_ERROR_CODES.missingInput,
    );
  });

  it('.handler() before .name() is a compile error', () => {
    // @ts-expect-error -- the unnamed schedule builder has no `.handler()`
    expect(q.schedule.daily('09:00').handler).toBeUndefined();
  });

  it('.use() then .job() is a compile error and throws scheduleMiddlewareWithJob', () => {
    const withMiddleware = q.schedule.everyMinutes(5).use(q.middleware(({ next }) => next()));
    const error = thrown(() =>
      // @ts-expect-error -- a schedule that wraps a job has no middleware of its own
      withMiddleware.job(stepJob),
    );
    expectCode(error, QUEUE_DEFINITION_ERROR_CODES.scheduleMiddlewareWithJob);
    expect(error).toHaveProperty('message', expect.stringContaining('Remove .use() before .job(guards:step)'));
  });

  it('untyped .use().job() throws scheduleMiddlewareWithJob', () => {
    // Plain JS: the types are gone, the definition-time throw remains.
    const untyped: Record<string, unknown> = q.schedule.everyMinutes(5).use(q.middleware(({ next }) => next()));
    const job = untyped['job'];
    if (typeof job !== 'function') throw new Error('Expected the runtime builder to still carry .job()');
    expectCode(
      thrown(() => Reflect.apply(job, untyped, [stepJob])),
      QUEUE_DEFINITION_ERROR_CODES.scheduleMiddlewareWithJob,
    );
  });

  it('builds once .name() and .input() ran, with middleware before .name()', () => {
    const schedule = q.schedule
      .interval(60_000)
      .use(q.middleware(({ next }) => next()))
      .name('guards:schedule-ok')
      .input(z.object({}))
      .handler(() => Promise.resolve());

    expect(schedule._type).toBe('schedule');
  });
});

describe('flow builder guards', () => {
  it('.build() before the first .step() is a compile error and throws missingSteps', () => {
    const noSteps = q.flow.name('guards:flow').input(z.object({}));
    expectCode(
      // @ts-expect-error -- `.build()` does not exist until the first `.step()`
      thrown(() => noSteps.build()),
      QUEUE_DEFINITION_ERROR_CODES.missingSteps,
    );
  });

  it('.build() before .input() is a compile error', () => {
    // @ts-expect-error -- the flow has no `.build()` until `.input()` and `.step()` ran
    expect(q.flow.name('guards:flow').build).toBeUndefined();
  });

  it('builds once a step exists', () => {
    const flow = q.flow
      .name('guards:flow-ok')
      .input(z.object({}))
      .step('first', { job: stepJob, data: () => ({}) })
      .build();

    expect(flow._type).toBe('flow');
  });

  it('has no .use(): each step runs with its own job middleware', () => {
    const flow = q.flow.name('guards:flow-no-use').input(z.object({}));
    // @ts-expect-error -- a flow has no middleware of its own
    expect(flow.use).toBeUndefined();
    const withStep = flow.step('first', { job: stepJob, data: () => ({}) });
    // @ts-expect-error -- not after a step either
    expect(withStep.use).toBeUndefined();
  });

  it('an unknown step id throws unknownStepDependency (runtime only)', () => {
    const flow = q.flow
      .name('guards:flow-unknown')
      .input(z.object({}))
      .step('first', { job: stepJob, data: () => ({}), dependsOn: ['missing'] });
    expectCode(
      thrown(() => flow.build()),
      QUEUE_DEFINITION_ERROR_CODES.unknownStepDependency,
    );
  });

  it('a dependency cycle throws circularStepDependency (runtime only)', () => {
    const flow = q.flow
      .name('guards:flow-cycle')
      .input(z.object({}))
      .step('a', { job: stepJob, data: () => ({}), dependsOn: ['b'] })
      .step('b', { job: stepJob, data: () => ({}), dependsOn: ['a'] });
    expectCode(
      thrown(() => flow.build()),
      QUEUE_DEFINITION_ERROR_CODES.circularStepDependency,
    );
  });
});

describe('cron helper guards', () => {
  it('out-of-range values throw invalidCronValue with the old message', () => {
    const error = thrown(() => CronPatterns.everySeconds(0));
    expectCode(error, QUEUE_DEFINITION_ERROR_CODES.invalidCronValue);
    expect(error).toHaveProperty('message', 'Seconds must be between 1 and 59');
    expectCode(
      thrown(() => CronPatterns.daily('24:00')),
      QUEUE_DEFINITION_ERROR_CODES.invalidCronValue,
    );
  });
});
