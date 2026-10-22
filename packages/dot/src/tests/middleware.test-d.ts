/**
 * `step` and `around` (`@arki/dot/orpc`): plain functions, typed at every procedure that uses them,
 * with no cast at the call site.
 *
 * Why these checks exist: a step's parameter is the only place its input is written, and its return
 * the only place its additions and refusals are written. The handler must see exactly what the step
 * added; a procedure that does not declare the step's failure, or whose context lacks what the step
 * reads, must not compile. An around adds nothing, so the context after it must equal the context
 * before it. Contract-first procedures must get the same checks.
 */
import { oc } from '@orpc/contract';
import { implement, os } from '@orpc/server';
import { expectTypeOf } from 'vitest';

import { defineFailure } from '@arki/failure';
import { errorMap } from '@arki/failure/orpc';

import { around, step } from '../orpc.js';

type Principal = { readonly user: { readonly id: string; readonly email: string } };
type RequestContext = { readonly principal: Principal | null; readonly headers: Headers };
type Db = { transaction<T>(work: () => Promise<T>): Promise<T> };

const SignInRequired = defineFailure('test.step.sign_in', { status: 401 });
const NotAdmin = defineFailure('test.step.not_admin', { status: 403 });

const authed = (ctx: { readonly principal: Principal | null }) =>
  ctx.principal === null ? SignInRequired() : { principal: ctx.principal };
const admin = (ctx: { readonly principal: Principal }) =>
  ctx.principal.user.email.endsWith('@arki.dev') ? { isAdmin: true as const } : NotAdmin();
const traced = (ctx: { readonly headers: Headers }) =>
  Promise.resolve({ traceId: ctx.headers.get('x-trace') ?? 'none' });
const inTransaction = <T>(ctx: { readonly db: Db }, next: () => Promise<T>) => ctx.db.transaction(next);

const o = os.$context<RequestContext>();

// A step adds the keys it returns; the handler sees the principal non-null, exactly.
o.errors(errorMap(SignInRequired))
  .use(step(authed))
  .handler(({ context }) => {
    expectTypeOf(context.principal).toEqualTypeOf<Principal>();
  });

// A later step reads what an earlier one added.
o.errors(errorMap(SignInRequired, NotAdmin))
  .use(step(authed))
  .use(step(admin))
  .handler(({ context }) => {
    expectTypeOf(context.isAdmin).toEqualTypeOf<true>();
    expectTypeOf(context.principal).toEqualTypeOf<Principal>();
  });

// A step that cannot fail needs no declared errors; an async step is awaited.
o.use(step(traced)).handler(({ context }) => {
  expectTypeOf(context.traceId).toEqualTypeOf<string>();
});

// An around adds nothing: the context after it is the context before it.
os.$context<{ readonly db: Db }>()
  .use(around(inTransaction))
  .handler(({ context }) => {
    expectTypeOf<keyof typeof context>().toEqualTypeOf<'db'>();
    expectTypeOf(context.db).toEqualTypeOf<Db>();
  });

// An inline around needs no annotation on `next`.
o.use(around(async (ctx: { readonly headers: Headers }, next) => (ctx.headers.has('x-slow') ? next() : next())));

// A procedure that does not declare the step's failure does not compile.
// @ts-expect-error — `test.step.sign_in` is missing from the procedure's errors
o.use(step(authed));

// `admin` reads a signed-in principal: before `authed` the context does not have one.
// @ts-expect-error — `principal` may still be null here
o.errors(errorMap(SignInRequired, NotAdmin)).use(step(admin));

// A context without the key the step reads does not compile.
// @ts-expect-error — the request context has no `principal`
os.$context<{ readonly headers: Headers }>().errors(errorMap(SignInRequired)).use(step(authed));

// An around that reads a key the context lacks does not compile.
// @ts-expect-error — the request context has no `db`
o.use(around(inTransaction));

// A step must add an object: a bare value has no key to land under.
// @ts-expect-error — `string` is not an object
step((ctx: { readonly headers: Headers }) => ctx.headers.get('x-trace') ?? 'none');

// Contract first: the contract's errors are what the step's failure is checked against.
const contract = oc.router({
  profile: oc.errors(errorMap(SignInRequired)),
  open: oc,
});
const impl = implement(contract).$context<RequestContext>();
impl.profile.use(step(authed)).handler(({ context }) => {
  expectTypeOf(context.principal).toEqualTypeOf<Principal>();
});
// @ts-expect-error — the `open` procedure's contract does not declare `test.step.sign_in`
impl.open.use(step(authed));
