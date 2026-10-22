/**
 * `step` and `around` (`@arki/http`): plain functions, typed at every route bundle that uses them,
 * with no cast at the call site.
 *
 * Why these checks exist: a step's parameter is the only place its input is written, and its return
 * the only place its additions and refusals are written. The handler must see exactly what the step
 * added; a bundle whose context lacks what a step reads, or whose route does not declare the step's
 * failure, must not compile. An around adds nothing, so the context after it must equal the context
 * before it.
 */
import { expectTypeOf } from 'vitest';
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

import type { BaseRequestCtx } from '../derive.js';
import { routes } from '../bundle.js';
import { route } from '../contract.js';
import { around, step } from '../middleware.js';

type Principal = { readonly user: { readonly id: string; readonly email: string } };
type Db = { transaction<T>(work: () => Promise<T>): Promise<T> };

const SignInRequired = defineFailure('test.step.sign_in', { status: 401 });
const NotAdmin = defineFailure('test.step.not_admin', { status: 403 });

const aPrincipal: Principal = { user: { id: 'u1', email: 'a@arki.dev' } };
const fromHeaders = (ctx: { readonly req: Request }) => ({
  principal: ctx.req.headers.has('authorization') ? aPrincipal : null,
});
const withDb = () => ({ db: { transaction: <T>(work: () => Promise<T>) => work() } });
const authed = (ctx: { readonly principal: Principal | null }) =>
  ctx.principal === null ? SignInRequired() : { principal: ctx.principal };
const admin = (ctx: { readonly principal: Principal }) =>
  ctx.principal.user.email.endsWith('@arki.dev') ? { isAdmin: true as const } : NotAdmin();
const asyncAdmin = (ctx: { readonly principal: Principal }) => Promise.resolve(admin(ctx));
const inTransaction = <T>(ctx: { readonly db: Db }, next: () => Promise<T>) => ctx.db.transaction(next);
const needsPrincipalAround = <T>(ctx: { readonly principal: Principal }, next: () => Promise<T>) => {
  void ctx;
  return next();
};
const notAnObject = () => 'text';

const declared = route.get('/declared', { id: 'declared', output: z.string(), failures: [SignInRequired, NotAdmin] });

// A step's additions are exactly what its function returns, minus its failures.
routes()
  .use(step(fromHeaders))
  .use(step(authed))
  .bind(declared, (_input, ctx) => {
    expectTypeOf(ctx.principal).toEqualTypeOf<Principal>();
    expectTypeOf(ctx.requestId).toEqualTypeOf<BaseRequestCtx['requestId']>();
    return '';
  });

// Chained steps see every key added before them; an async step is awaited.
routes()
  .use(step(fromHeaders))
  .use(step(authed))
  .use(step(asyncAdmin))
  .bind(declared, (_input, ctx) => {
    expectTypeOf(ctx.isAdmin).toEqualTypeOf<true>();
    expectTypeOf(ctx.principal).toEqualTypeOf<Principal>();
    return '';
  });

// An around adds nothing: the context after it equals the context before it.
routes()
  .use(step(withDb))
  .use(around(inTransaction))
  .bind(route.get('/plain', { id: 'plain', output: z.string() }), (_input, ctx) => {
    expectTypeOf(ctx).toEqualTypeOf<BaseRequestCtx & ReturnType<typeof withDb>>();
    return '';
  });

// A step refusal must be declared by the route, like a keyed deriver's.
routes()
  .use(step(fromHeaders))
  .use(step(authed))
  // @ts-expect-error -- SignInRequired is not declared by this route
  .bind(route.get('/hidden', { id: 'hidden', output: z.string() }), () => '');

// The step before it did not add `principal`.
// @ts-expect-error -- the context has no `principal` yet
routes().use(step(authed));

// Order matters: `admin` reads what `authed` adds.
routes()
  .use(step(fromHeaders))
  // @ts-expect-error -- `authed` has not run yet, so `principal` can still be null
  .use(step(admin));

// An around reads the context too.
// @ts-expect-error -- the context has no `db` yet
routes().use(around(inTransaction));
// @ts-expect-error -- `principal` is only possibly null here
routes().use(step(fromHeaders)).use(around(needsPrincipalAround));

// A step returns an object or a failure, nothing else.
// @ts-expect-error -- a string is not an object
routes().use(step(notAnObject));
