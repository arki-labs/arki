/**
 * `step` and `around` (`@arki/queue`): plain functions, typed at every job that uses them,
 * with no cast at the call site.
 *
 * Why these checks exist: a step's parameter is the only place its input is written, and its return
 * the only place its additions and refusals are written. The handler must see exactly what the step
 * added; a job whose context lacks what the step reads, or where a step runs before the one that
 * provides its input, must not compile. An around adds nothing, so the context after it must equal
 * the context before it.
 */
import { expectTypeOf } from 'vitest';

import type { FailureOf } from '@arki/failure';
import { z } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

import { initQueue } from './init.ts';
import { around, step } from './step.ts';

type Principal = { readonly user: { readonly id: string; readonly email: string } };
type AppContext = { readonly principal: Principal | null; readonly headers: Headers };
type Db = { transaction<T>(work: () => Promise<T>): Promise<T> };

const SignInRequired = defineFailure('test.queue.step.sign_in', { status: 401 });
const NotAdmin = defineFailure('test.queue.step.not_admin', { status: 403 });

const authed = (ctx: { readonly principal: Principal | null }) =>
  ctx.principal === null ? SignInRequired() : { principal: ctx.principal };
const admin = (ctx: { readonly principal: Principal }) =>
  ctx.principal.user.email.endsWith('@arki.dev') ? { isAdmin: true as const } : NotAdmin();
const traced = (ctx: { readonly headers: Headers }) =>
  Promise.resolve({ traceId: ctx.headers.get('x-trace') ?? 'none' });
const inTransaction = <T>(ctx: { readonly db: Db }, next: () => Promise<T>) => ctx.db.transaction(next);

const input = z.object({ id: z.string() });
const q = initQueue.context<AppContext>().create();
const withDb = initQueue.context<AppContext & { readonly db: Db }>().create();

// A step adds the keys it returns; the handler sees the principal non-null, exactly, and keeps the rest.
const _signedIn = q.job
  .use(step(authed))
  .name('queue-step.signed-in')
  .input(input)
  .handler((_data, ctx) => {
    expectTypeOf(ctx.principal).toEqualTypeOf<Principal>();
    expectTypeOf(ctx.headers).toEqualTypeOf<Headers>();
    expectTypeOf(ctx.updateProgress).toBeFunction();
    return Promise.resolve(ctx.principal.user.id);
  });
// The step's refusal joins the job's result.
expectTypeOf<Awaited<ReturnType<typeof _signedIn._internal.handler>>>().toEqualTypeOf<
  string | FailureOf<typeof SignInRequired>
>();

// A later step reads what an earlier one added.
q.job
  .use(step(authed))
  .use(step(admin))
  .name('queue-step.admin')
  .input(input)
  .handler((_data, ctx) => {
    expectTypeOf(ctx.isAdmin).toEqualTypeOf<true>();
    expectTypeOf(ctx.principal).toEqualTypeOf<Principal>();
    return Promise.resolve(1);
  });

// An async step is awaited.
q.job
  .use(step(traced))
  .name('queue-step.traced')
  .input(input)
  .handler((_data, ctx) => {
    expectTypeOf(ctx.traceId).toEqualTypeOf<string>();
    return Promise.resolve(1);
  });

// An around adds nothing: the context after it is the context before it.
withDb.job
  .use(around(inTransaction))
  .name('queue-step.around')
  .input(input)
  .handler((_data, ctx) => {
    expectTypeOf(ctx.db).toEqualTypeOf<Db>();
    expectTypeOf(ctx.principal).toEqualTypeOf<Principal | null>();
    return Promise.resolve(1);
  });
const beforeAround = withDb.job;
const afterAround = beforeAround.use(around(inTransaction));
expectTypeOf(afterAround).toEqualTypeOf<typeof beforeAround>();

// An inline around needs no annotation on `next`.
q.job.use(around(async (ctx: { readonly headers: Headers }, next) => (ctx.headers.has('x-slow') ? next() : next())));

// `admin` reads a signed-in principal: before `authed` the context does not have one.
// @ts-expect-error — `principal` may still be null here
q.job.use(step(admin));

// A context without the key the step reads does not compile.
// @ts-expect-error — the job context has no `principal`
initQueue.context<{ readonly headers: Headers }>().create().job.use(step(authed));

// An around reading a key the context lacks does not compile.
// @ts-expect-error — the job context has no `db`
q.job.use(around(inTransaction));

// A step returns an object or a failure, never a bare value.
// @ts-expect-error — a step must return an object
step((_ctx: AppContext) => 42);
