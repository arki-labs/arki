/**
 * `step` and `around` (`@arki/queue`) at run time, through `executeJob` (no Redis needed).
 *
 * Why these tests exist: a step's refusal must be the job's outcome, exactly as if the handler had
 * returned that failure: the handler never runs, and the failure keeps its code. What a step returns
 * must reach the handler, and a later step must see what an earlier one added. An around must wrap
 * every later step and the handler, pass their result through, and see a refusal or a handler error
 * as a failed run (a transaction rolls back).
 */
import { describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';
import { defineFailure, UnexpectedDefect } from '@arki/failure';

import type { JobLike } from './types/job.ts';
import { initQueue } from './init.ts';
import { executeJob } from './job-outcome.ts';
import { around, step } from './step.ts';

type Principal = { readonly user: { readonly id: string; readonly email: string } };
type AppContext = { readonly principal: Principal | null; readonly events: string[] };

const SignInRequired = defineFailure('test.queue.step.rt_sign_in', { status: 401 });
const NotAdmin = defineFailure('test.queue.step.rt_not_admin', { status: 403 });

const authed = (ctx: { readonly principal: Principal | null; readonly events: string[] }) => {
  ctx.events.push('authed');
  return ctx.principal === null ? SignInRequired() : { principal: ctx.principal };
};
const admin = (ctx: { readonly principal: Principal; readonly events: string[] }) => {
  ctx.events.push('admin');
  return ctx.principal.user.email.endsWith('@arki.dev') ? { isAdmin: true as const } : NotAdmin();
};
const inTransaction = async <T>(ctx: { readonly events: string[] }, next: () => Promise<T>) => {
  ctx.events.push('open');
  try {
    const result = await next();
    ctx.events.push('commit');
    return result;
  } catch (error) {
    ctx.events.push('rollback');
    throw error;
  }
};

const ada: Principal = { user: { id: 'u1', email: 'ada@arki.dev' } };
const bob: Principal = { user: { id: 'u2', email: 'bob@example.com' } };
const wireJob: JobLike = {
  name: 'step-test',
  data: { id: 'x' },
  attemptsMade: 0,
  updateProgress: () => Promise.resolve(),
  log: () => Promise.resolve(),
};
const input = z.object({ id: z.string() });

function setup(principal: Principal | null) {
  const events: string[] = [];
  const q = initQueue.context<AppContext>().create();
  return { events, q, context: () => ({ principal, events }) };
}

describe('step', () => {
  it('hands the handler what the step returned and lets a later step read an earlier one', async () => {
    const { events, q, context } = setup(ada);
    const job = q.job
      .use(step(authed))
      .use(step(admin))
      .name('step-test.chain')
      .input(input)
      .handler((_data, ctx) => {
        events.push('handler');
        return Promise.resolve({ who: ctx.principal.user.id, isAdmin: ctx.isAdmin });
      });
    expect(await executeJob(job._internal, wireJob, context)).toEqual({ who: 'u1', isAdmin: true });
    expect(events).toEqual(['authed', 'admin', 'handler']);
  });

  it('makes a refusal the job outcome and never runs the handler or the later steps', async () => {
    const { events, q, context } = setup(null);
    const job = q.job
      .use(step(authed))
      .use(step(admin))
      .name('step-test.refuse')
      .input(input)
      .handler(() => {
        events.push('handler');
        return Promise.resolve('done');
      });
    const outcome = await executeJob(job._internal, wireJob, context);
    expect(SignInRequired.is(outcome)).toBe(true);
    expect(events).toEqual(['authed']);
  });

  it('keeps the refusal of a later step distinct from an earlier one', async () => {
    const { events, q, context } = setup(bob);
    const job = q.job
      .use(step(authed))
      .use(step(admin))
      .name('step-test.refuse-late')
      .input(input)
      .handler(() => Promise.resolve('done'));
    expect(NotAdmin.is(await executeJob(job._internal, wireJob, context))).toBe(true);
    expect(events).toEqual(['authed', 'admin']);
  });
});

describe('around', () => {
  it('wraps later steps and the handler, and passes the result through', async () => {
    const { events, q, context } = setup(ada);
    const job = q.job
      .use(around(inTransaction))
      .use(step(authed))
      .name('step-test.around')
      .input(input)
      .handler((_data, ctx) => {
        events.push('handler');
        return Promise.resolve(ctx.principal.user.id);
      });
    expect(await executeJob(job._internal, wireJob, context)).toBe('u1');
    expect(events).toEqual(['open', 'authed', 'handler', 'commit']);
  });

  it('receives a refusal as the value next() resolves to, and the refusal is still the outcome', async () => {
    const { events, q, context } = setup(null);
    const job = q.job
      .use(around(inTransaction))
      .use(step(authed))
      .name('step-test.around-refusal')
      .input(input)
      .handler(() => Promise.resolve('done'));
    expect(SignInRequired.is(await executeJob(job._internal, wireJob, context))).toBe(true);
    expect(events).toEqual(['open', 'authed', 'commit']);
  });

  it('still sees a thrown handler error as a rejection (rollback)', async () => {
    const { events, q, context } = setup(ada);
    const job = q.job
      .use(around(inTransaction))
      .name('step-test.around-error')
      .input(input)
      .handler(() => {
        return Promise.reject(new Error('boom'));
      });
    const outcome = await executeJob(job._internal, wireJob, context);
    expect(UnexpectedDefect.is(outcome)).toBe(true);
    expect(events).toEqual(['open', 'rollback']);
  });

  it('nests: an outer around receives a refusal from inside an inner around as a value', async () => {
    const { events, q, context } = setup(null);
    const job = q.job
      .use(around(inTransaction))
      .use(
        around(async (ctx: { readonly events: string[] }, next) => {
          ctx.events.push('inner-open');
          return next();
        }),
      )
      .use(step(authed))
      .name('step-test.around-nested')
      .input(input)
      .handler(() => Promise.resolve('done'));
    expect(SignInRequired.is(await executeJob(job._internal, wireJob, context))).toBe(true);
    expect(events).toEqual(['open', 'inner-open', 'authed', 'commit']);
  });
});
