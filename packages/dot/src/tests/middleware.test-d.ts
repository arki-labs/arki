/**
 * `derive` + `fromDerive` (`@arki/dot/orpc`): a context step written once is typed at every
 * procedure that uses it, with no cast anywhere.
 *
 * Why these checks exist: the step's parameter is the only place its input is written, and its
 * return the only place its additions and refusals are written. The handler must see exactly what
 * the step added; a procedure that does not declare the step's failure, or whose context lacks what
 * the step reads, must not compile. Contract-first procedures must get the same checks.
 */
import { oc } from '@orpc/contract';
import { implement, os } from '@orpc/server';
import { expectTypeOf } from 'vitest';

import { defineFailure } from '@arki/failure';
import { errorMap } from '@arki/failure/orpc';

import { derive } from '../middleware.js';
import { fromDerive } from '../orpc.js';

type Principal = { readonly user: { readonly id: string; readonly email: string } };
type RequestContext = { readonly principal: Principal | null; readonly headers: Headers };

const SignInRequired = defineFailure('test.derive.sign_in', { status: 401 });
const NotAdmin = defineFailure('test.derive.not_admin', { status: 403 });

const authed = derive('principal', (ctx: { readonly principal: Principal | null }) =>
  ctx.principal === null ? SignInRequired() : ctx.principal,
);
const admin = derive((ctx: { readonly principal: Principal }) =>
  ctx.principal.user.email.endsWith('@arki.dev') ? { isAdmin: true as const } : NotAdmin(),
);
const traced = derive('traceId', (ctx: { readonly headers: Headers }) =>
  Promise.resolve(ctx.headers.get('x-trace') ?? 'none'),
);

const o = os.$context<RequestContext>();

// The keyed form adds one key; the handler sees the principal non-null, exactly.
o.errors(errorMap(SignInRequired))
  .use(fromDerive(authed))
  .handler(({ context }) => {
    expectTypeOf(context.principal).toEqualTypeOf<Principal>();
  });

// The object form adds every key; a later step reads what an earlier one added.
o.errors(errorMap(SignInRequired, NotAdmin))
  .use(fromDerive(authed))
  .use(fromDerive(admin))
  .handler(({ context }) => {
    expectTypeOf(context.isAdmin).toEqualTypeOf<true>();
    expectTypeOf(context.principal).toEqualTypeOf<Principal>();
  });

// A step that cannot fail needs no declared errors; an async step is awaited.
o.use(fromDerive(traced)).handler(({ context }) => {
  expectTypeOf(context.traceId).toEqualTypeOf<string>();
});

// A procedure that does not declare the step's failure does not compile.
// @ts-expect-error — `test.derive.sign_in` is missing from the procedure's errors
o.use(fromDerive(authed));

// `admin` reads a signed-in principal: before `authed` the context does not have one.
// @ts-expect-error — `principal` may still be null here
o.errors(errorMap(SignInRequired, NotAdmin)).use(fromDerive(admin));

// A context without the key the step reads does not compile.
// @ts-expect-error — the request context has no `principal`
os.$context<{ readonly headers: Headers }>().errors(errorMap(SignInRequired)).use(fromDerive(authed));

// Contract first: the contract's errors are what the step's failure is checked against.
const contract = oc.router({
  profile: oc.errors(errorMap(SignInRequired)),
  open: oc,
});
const impl = implement(contract).$context<RequestContext>();
impl.profile.use(fromDerive(authed)).handler(({ context }) => {
  expectTypeOf(context.principal).toEqualTypeOf<Principal>();
});
// @ts-expect-error — the `open` procedure's contract does not declare `test.derive.sign_in`
impl.open.use(fromDerive(authed));
