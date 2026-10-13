/**
 * Type contract: a job built with `q.job` can be wrapped by a schedule and
 * used as a flow step as-is, with no cast, whatever its own middleware adds
 * to the context: the job's own worker runs it in both cases.
 *
 * Built jobs carry a concrete output and context type. The builders used to
 * ask for `JobDefinition<TInput, unknown, unknown>`, which rejects every real
 * job (the handler's context parameter is contravariant), so callers cast
 * with `as never` and lost the input check. The `@ts-expect-error` lines fail
 * `bun run typecheck` if a guard stops firing (this file is listed under
 * `files` in tsconfig.json for that reason). No Redis needed: nothing here
 * registers or runs a job.
 */

import { describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';

import { initQueue } from './init.ts';
import type { JobContext } from './types/job.ts';

type TestContext = { userId: string };

const q = initQueue.context<TestContext>().create();

/** A real job: typed input, typed output, and a handler that reads the queue context. */
const sendEmail = q.job
  .name('real-jobs:send-email')
  .input(z.object({ to: z.string() }))
  .handler((data, ctx) => Promise.resolve({ sentTo: data.to, by: ctx.userId }));

/** A job whose middleware adds `db` to the context. Its own worker runs that middleware. */
const withDb = q.middleware<JobContext<TestContext>, JobContext<TestContext> & { db: string }>(({ ctx, next }) =>
  next({ ctx: { ...ctx, db: 'pg' } }),
);
const needsDb = q.job
  .use(withDb)
  .name('real-jobs:needs-db')
  .input(z.object({ id: z.string() }))
  .handler((data, ctx) => Promise.resolve(`${ctx.db}:${data.id}`));

describe('real jobs in schedules', () => {
  it('accepts a real job and checks the schedule data against its input', () => {
    const schedule = q.schedule.cron('0 0 * * *').job(sendEmail).data({ to: 'a@b.c' });
    expect(schedule._type).toBe('schedule');
  });

  it('rejects schedule data that does not match the job input', () => {
    // @ts-expect-error -- `to` must be a string: the job's input type flows into `.data()`
    const schedule = q.schedule.cron('0 0 * * *').job(sendEmail).data({ to: 42 });
    expect(schedule._type).toBe('schedule');
  });

  it('accepts a job with its own middleware, with no schedule middleware', () => {
    // A schedule only adds data to the job's queue; the job's own worker runs
    // its own middleware (`withDb`), so the schedule needs none.
    const schedule = q.schedule.cron('0 0 * * *').job(needsDb).data({ id: 'x' });
    expect(schedule._type).toBe('schedule');
  });

  it('rejects schedule middleware in front of a job', () => {
    // A schedule that wraps a job has no middleware of its own.
    // @ts-expect-error -- the builder after `.use()` has no `.job()`
    expect(() => q.schedule.cron('0 0 * * *').use(withDb).job(needsDb)).toThrow();
  });

  it('rejects schedule middleware in front of a named job schedule', () => {
    // @ts-expect-error -- `.use().name()` leads to an inline handler only, never `.job()`
    expect(() => q.schedule.cron('0 0 * * *').use(withDb).name('real-jobs-named').job(needsDb)).toThrow();
  });

  it('names a schedule that wraps a job', () => {
    const schedule = q.schedule.cron('0 0 * * *').name('real-jobs-nightly').job(sendEmail).data({ to: 'a@b.c' });
    expect(schedule._internal).toMatchObject({ name: 'real-jobs-nightly' });
  });

  it('rejects named schedule data that does not match the job input', () => {
    // @ts-expect-error -- `to` must be a string, also after `.name()`
    const schedule = q.schedule.cron('0 0 * * *').name('real-jobs-bad').job(sendEmail).data({ to: 42 });
    expect(schedule._type).toBe('schedule');
  });
});

describe('real jobs as flow steps', () => {
  it('accepts real jobs and checks each step data against its job input', () => {
    const flow = q.flow
      .name('real-jobs:flow')
      .input(z.object({ email: z.string(), id: z.string() }))
      .step('email', { job: sendEmail, data: input => ({ to: input.email }) })
      // A step job runs on its own worker with its own middleware, so `needsDb` fits here.
      .step('db', { job: needsDb, data: input => ({ id: input.id }), dependsOn: ['email'] })
      .build();
    expect(flow._type).toBe('flow');
  });

  it('rejects step data that does not match the job input', () => {
    const flow = q.flow
      .name('real-jobs:bad-flow')
      .input(z.object({ email: z.string() }))
      // @ts-expect-error -- the job wants `{ to: string }`, not `{ email: string }`
      .step('email', { job: sendEmail, data: input => ({ email: input.email }) })
      .build();
    expect(flow._type).toBe('flow');
  });
});
