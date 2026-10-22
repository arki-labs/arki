/**
 * Principal steps: plain functions that read `ctx.principal` and either narrow it to non-null or
 * refuse the call. They import no transport, so one function serves every transport's `step()`:
 *
 * @example
 * import { authed } from '@arki/auth';
 * import { step } from '@arki/dot/orpc'; // or '@arki/http', '@arki/queue'
 * impl.profile.use(step(authed)).handler(({ context }) => context.principal.user.id);
 *
 * Each step is generic in the principal, so the handler after it keeps the app's own principal
 * type (exposed columns, branded ids), not {@link AnyPrincipal}.
 */
import type { AnyPrincipal } from './principal.js';
import { AccessDenied, AuthenticationRequired } from './boundary-failures.js';

/** Signed in, or `auth.unauthenticated` (401). */
export function authed<P extends AnyPrincipal>(ctx: { readonly principal: P | null }) {
  return ctx.principal === null ? AuthenticationRequired() : { principal: ctx.principal };
}

/** Signed in with a verified email: a guest is `auth.unauthenticated` (401), an unverified email `auth.forbidden` (403). */
export function verified<P extends AnyPrincipal>(ctx: { readonly principal: P | null }) {
  if (ctx.principal === null) return AuthenticationRequired();
  return ctx.principal.user.emailVerified ? { principal: ctx.principal } : AccessDenied();
}

/** Signed in with the role `name`: a guest is `auth.unauthenticated` (401), a missing role `auth.forbidden` (403). */
export function role(name: string) {
  return <P extends AnyPrincipal>(ctx: { readonly principal: P | null }) => {
    if (ctx.principal === null) return AuthenticationRequired();
    return ctx.principal.roles.includes(name) ? { principal: ctx.principal } : AccessDenied();
  };
}
