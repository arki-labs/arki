/**
 * `with: [...]` on a schedule: plain steps and arounds, typed at the definition, no cast.
 *
 * Why these checks exist: a step's parameter is the only place its input is written, and its return
 * the only place its additions and refusals are written. The handler must see exactly what the steps
 * added, in order; an element that reads a key the context built so far lacks must not compile, and
 * neither must a step listed before the step that provides its input. An around adds nothing, so the
 * context after it equals the context before it. A step's refusal is a possible result of the run.
 */
import { expectTypeOf } from 'vitest';

import { defineFailure } from '@arki/failure';

import type { ScheduleRunResult } from './runtime.js';
import { initSchedule } from './index.js';

type Principal = { readonly user: { readonly id: string; readonly email: string } };
type Db = { transaction<T>(work: () => Promise<T>): Promise<T> };
type BaseContext = { readonly principal: Principal | null; readonly db: Db };

const SignInRequired = defineFailure('test.with.sign_in', { status: 401 });
const NotAdmin = defineFailure('test.with.not_admin', { status: 403 });

const authed = (ctx: { readonly principal: Principal | null }) =>
  ctx.principal === null ? SignInRequired() : { principal: ctx.principal };
const admin = (ctx: { readonly principal: Principal }) =>
  ctx.principal.user.email.endsWith('@arki.dev') ? { isAdmin: true as const } : NotAdmin();
const traced = (ctx: { readonly db: Db }) => Promise.resolve({ traceId: String(ctx.db.transaction.length) });
const inTransaction = <T>(ctx: { readonly db: Db }, next: () => Promise<T>) => ctx.db.transaction(next);

const builder = initSchedule.context<BaseContext>().create();

// A step adds the keys it returns; the handler sees the principal non-null, exactly.
const single = builder.define({
  name: 'single',
  every: '1h',
  with: [authed],
  handler: ctx => {
    expectTypeOf(ctx.principal).toEqualTypeOf<Principal>();
    expectTypeOf(ctx.db).toEqualTypeOf<Db>();
    return Promise.resolve('ok' as const);
  },
});

// The step's refusal is a possible result of the run.
expectTypeOf<
  Extract<ScheduleRunResult<'ok' | ReturnType<typeof SignInRequired>>, { status: 'refused' }>
>().not.toBeNever();
expectTypeOf(single.handler).returns.resolves.toEqualTypeOf<'ok' | ReturnType<typeof SignInRequired>>();

// A later step reads what an earlier one added.
builder.define({
  name: 'chain',
  every: '1h',
  with: [authed, admin],
  handler: ctx => {
    expectTypeOf(ctx.isAdmin).toEqualTypeOf<true>();
    expectTypeOf(ctx.principal).toEqualTypeOf<Principal>();
    return Promise.resolve(null);
  },
});

// An async step is awaited.
builder.define({
  name: 'async-step',
  every: '1h',
  with: [traced],
  handler: ctx => {
    expectTypeOf(ctx.traceId).toEqualTypeOf<string>();
    return Promise.resolve(null);
  },
});

// An around adds nothing: the context after it is the context before it.
builder.define({
  name: 'around',
  every: '1h',
  with: [inTransaction],
  handler: ctx => {
    expectTypeOf(ctx).toEqualTypeOf<BaseContext>();
    return Promise.resolve(null);
  },
});

// An around in the middle keeps what came before and lets later steps add on.
builder.define({
  name: 'around-middle',
  every: '1h',
  with: [authed, inTransaction, admin],
  handler: ctx => {
    expectTypeOf(ctx.isAdmin).toEqualTypeOf<true>();
    return Promise.resolve(null);
  },
});

// An inline around is generic in `T` and annotates `next`: the list gives no contextual type to a position.
builder.define({
  name: 'inline-around',
  every: '1h',
  with: [async <T>(_ctx: { readonly db: Db }, next: () => Promise<T>) => next()],
  handler: () => Promise.resolve(null),
});

// With no base context (`undefined`), the first step's additions become the context.
initSchedule.create().define({
  name: 'no-base',
  every: '1h',
  with: [() => ({ system: true as const })],
  handler: ctx => {
    expectTypeOf(ctx).toEqualTypeOf<{ system: true }>();
    return Promise.resolve(null);
  },
});

// Without `with`, the handler's context is the base context, as before.
builder.define({
  name: 'plain',
  every: '1h',
  handler: ctx => {
    expectTypeOf(ctx).toEqualTypeOf<BaseContext>();
    return Promise.resolve(null);
  },
});

// A context without the key a step reads does not compile.
initSchedule
  .context<{ readonly db: Db }>()
  .create()
  .define({
    name: 'missing-key',
    every: '1h',
    // @ts-expect-error — the base context has no `principal`
    with: [authed],
    handler: () => Promise.resolve(null),
  });

// `admin` reads a signed-in principal: listed before `authed`, the context has none yet.
builder.define({
  name: 'wrong-order',
  every: '1h',
  // @ts-expect-error — `principal` may still be null at position 0
  with: [admin, authed],
  handler: () => Promise.resolve(null),
});

// An around that reads a key the context lacks does not compile.
initSchedule
  .context<{ readonly headers: Headers }>()
  .create()
  .define({
    name: 'around-missing-key',
    every: '1h',
    // @ts-expect-error — the base context has no `db`
    with: [inTransaction],
    handler: () => Promise.resolve(null),
  });

// A step must add an object: a bare value has no key to land under.
builder.define({
  name: 'non-object',
  every: '1h',
  // @ts-expect-error — `string` is not an object
  with: [(_ctx: { readonly db: Db }) => 'a'],
  handler: () => Promise.resolve(null),
});
