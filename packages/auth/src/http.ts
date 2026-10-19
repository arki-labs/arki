/**
 * `@arki/auth/http` — the principal as an `@arki/http` deriver, and policy checks as a handler
 * wrapper. Node and Bun.
 *
 * @example
 * routes().derive(withPrincipal(auth)).bind(getProfile, (_input, ctx) => repo.byUser(ctx.principal.user.id));
 */
import type { BaseRequestCtx } from '@arki/http';
import { derive } from '@arki/http';

import type { AUTH_POLICY_FAILURES, PrincipalChecks, PrincipalSource } from './boundary-failures.js';
import type { AnyPolicies, GroupOf, Loaded, PolicyName, PrincipalOfPolicies, SubjectOf } from './policies.js';
import type { AnyPrincipal } from './principal.js';
import {
  AccessDenied,
  AuthenticationRateLimited,
  AuthenticationRequired,
  checkPrincipal,
  isAuthBoundaryFailure,
  resolvePrincipal,
  ResourceMissing,
} from './boundary-failures.js';
import { authorizePolicy, groupOf, keyed } from './policies.js';

export type { PrincipalSource } from './boundary-failures.js';

/** Checks applied to the resolved principal. */
export type WithPrincipalOptions = PrincipalChecks;

/** Response headers for canonical auth refusals returned by a deriver or policy handler. */
export function authFailureHeaders<Value>(failure: Value): Readonly<Record<string, string>> | undefined {
  if (AuthenticationRequired.is(failure)) return { 'www-authenticate': 'Bearer' };
  if (AuthenticationRateLimited.is(failure) && failure.data.retryAfter !== undefined) {
    return { 'retry-after': String(failure.data.retryAfter) };
  }
  return undefined;
}

/** `ctx.principal` for signed-in callers; a guest gets 401, a refused check 403. */
export function withPrincipal<P extends AnyPrincipal>(auth: PrincipalSource<P>, options: WithPrincipalOptions = {}) {
  return derive(
    'principal',
    async request => {
      const principal = await resolvePrincipal(auth, request.headers);
      if (isAuthBoundaryFailure(principal)) return principal;
      return checkPrincipal(principal, options);
    },
    { failureHeaders: authFailureHeaders },
  );
}

/** `ctx.principal` for any caller: the principal, or `null` for a guest. */
export function withOptionalPrincipal<P extends AnyPrincipal>(auth: PrincipalSource<P>) {
  return derive('principal', request => resolvePrincipal(auth, request.headers), {
    failureHeaders: authFailureHeaders,
  });
}

/** The handler context after a policy check: a signed-in principal, and the subject under its group's name. */
type SignedIn<Ctx extends { readonly principal: unknown }> = Ctx & {
  readonly principal: NonNullable<Ctx['principal']>;
};

/**
 * Wrap a handler in a policy check. It runs after the input is decoded, so `load` reads the typed
 * `params` and `body`. The bundle must derive `principal` first (`withOptionalPrincipal(auth)`).
 *
 * - a guest → 401 `auth.unauthenticated`; the loader does not run;
 * - no such subject, or the group's `view` refuses → 404 `auth.not_found` (it looks missing);
 * - the policy refuses → 403 `auth.forbidden`.
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
) => (input: I, ctx: Ctx) => Promise<R | ReturnType<(typeof AUTH_POLICY_FAILURES)[number]>> {
  return (name, load, handler) => async (input, ctx) => {
    const principal = ctx.principal;
    if (principal === null) return AuthenticationRequired();
    const signedIn = { ...ctx, principal };
    const subject = await authorizePolicy(policies, name, principal, await load(input, signedIn));
    if (AccessDenied.is(subject)) return AccessDenied();
    if (ResourceMissing.is(subject)) return ResourceMissing();
    return handler(input, { ...signedIn, ...keyed(groupOf(name), subject) });
  };
}
