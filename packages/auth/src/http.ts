/**
 * `@arki/auth/http` — the principal as an `@arki/http` deriver, and policy checks as a handler
 * wrapper. Node and Bun.
 *
 * @example
 * routes().derive(withPrincipal(auth)).bind(getProfile, (_input, ctx) => repo.byUser(ctx.principal.user.id));
 */
import type { BaseRequestCtx, Deriver } from '@arki/http';
import { derive, HTTP_ERROR_CODES, HttpError } from '@arki/http';

import type { AnyPolicies, GroupOf, Loaded, PolicyName, PrincipalOfPolicies, SubjectOf } from './policies.js';
import type { AnyPrincipal } from './principal.js';
import { AUTH_ERROR_CODES, isAuthError } from './errors.js';
import { decide, groupOf, keyed } from './policies.js';

/** Anything that resolves a principal from request headers: an `Auth` from `@arki/auth/pg`. */
export type PrincipalSource<P extends AnyPrincipal> = {
  readonly principal: (headers: Headers) => Promise<P | null>;
};

export type WithPrincipalOptions = {
  /** Refuse a user whose email is not verified (403). */
  readonly verified?: boolean;
  /** Refuse a principal without this role (403). */
  readonly role?: string;
};

/** The auth's own refusals (a cookie and a bearer token together) keep their status and code. */
async function resolve<P extends AnyPrincipal>(auth: PrincipalSource<P>, request: Request): Promise<P | null> {
  try {
    return await auth.principal(request.headers);
  } catch (error) {
    if (isAuthError(error)) throw new HttpError(error.status, error.code, error.message, { cause: error });
    throw error;
  }
}

const unauthenticated = () =>
  new HttpError(401, AUTH_ERROR_CODES.unauthenticated, 'Sign in to continue.', {
    headers: { 'www-authenticate': 'Bearer' },
  });

/** `ctx.principal` for signed-in callers; a guest gets 401, a refused check 403. */
export function withPrincipal<P extends AnyPrincipal>(
  auth: PrincipalSource<P>,
  options: WithPrincipalOptions = {},
): Deriver<'principal', P> {
  return derive('principal', async request => {
    const principal = await resolve(auth, request);
    if (principal === null) throw unauthenticated();
    if (options.verified === true && !principal.user.emailVerified) {
      throw new HttpError(403, AUTH_ERROR_CODES.forbidden, 'Verify your email address first.');
    }
    if (options.role !== undefined && !principal.roles.includes(options.role)) {
      throw new HttpError(403, AUTH_ERROR_CODES.forbidden, 'You do not have access to this.');
    }
    return principal;
  });
}

/** `ctx.principal` for any caller: the principal, or `null` for a guest. */
export function withOptionalPrincipal<P extends AnyPrincipal>(
  auth: PrincipalSource<P>,
): Deriver<'principal', P | null> {
  return derive('principal', request => resolve(auth, request));
}

/** The handler context after a policy check: a signed-in principal, and the subject under its group's name. */
type SignedIn<Ctx extends { readonly principal: unknown }> = Ctx & {
  readonly principal: NonNullable<Ctx['principal']>;
};

/**
 * Wrap a handler in a policy check. It runs after the input is decoded, so `load` reads the typed
 * `params` and `body`. The bundle must derive `principal` first (`withOptionalPrincipal(auth)`).
 *
 * - a guest → 401 `ARKI_AUTH_E401`; the loader does not run;
 * - no such subject, or the group's `view` refuses → 404 `ARKI_HTTP_E404` (it looks missing);
 * - the policy refuses → 403 `ARKI_AUTH_E403`.
 *
 * @example
 * routes()
 *   .derive(withOptionalPrincipal(auth))
 *   .bind(refundOrder, authorize(orderPolicies)('order.refund', ({ params }, ctx) => ctx.orders.byId(params.id), (_input, { order }) => refund(order)));
 */
export function authorize<T extends AnyPolicies>(
  policies: T,
): <
  N extends PolicyName<T>,
  I,
  Ctx extends BaseRequestCtx & { readonly principal: (AnyPrincipal & PrincipalOfPolicies<T>) | null },
  R,
>(
  name: N,
  load: (input: I, ctx: SignedIn<Ctx>) => Loaded<SubjectOf<T, N>>,
  handler: (input: I, ctx: SignedIn<Ctx> & Readonly<Record<GroupOf<N>, SubjectOf<T, N>>>) => R | Promise<R>,
) => (input: I, ctx: Ctx) => Promise<R> {
  return (name, load, handler) => async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw unauthenticated();
    const signedIn = { ...ctx, principal };
    const decision = await decide(policies, name, principal, await load(input, signedIn));
    if (!decision.allowed) {
      if (decision.outcome === 'forbidden') {
        throw new HttpError(403, AUTH_ERROR_CODES.forbidden, 'You do not have access to this.');
      }
      throw new HttpError(404, HTTP_ERROR_CODES.notFound, `${groupOf(name)} not found`);
    }
    return handler(input, { ...signedIn, ...keyed(groupOf(name), decision.subject) });
  };
}
