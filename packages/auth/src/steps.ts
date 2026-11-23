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
import { AccessDenied, AuthenticationRequired, SessionNotFresh } from './boundary-failures.js';
import { AUTH_ERROR_CODES, AuthError } from './errors.js';

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

/**
 * Signed in less than `sessions.freshFor` seconds ago: a guest is `auth.unauthenticated` (401), an
 * older session `auth.session_not_fresh` (403, with `freshFor`). A fresh sign-in on the same device
 * replaces the old session, so the caller passes on the next try. A principal from an auth without
 * `sessions.freshFor` throws `ARKI_AUTH_E001`: that is a setup bug, not a refusal.
 */
export function freshSession<P extends AnyPrincipal>(ctx: { readonly principal: P | null }) {
  if (ctx.principal === null) return AuthenticationRequired();
  const { freshFor, session } = ctx.principal;
  if (freshFor === undefined) {
    throw new AuthError(
      AUTH_ERROR_CODES.invalidConfig,
      '[@arki/auth] `freshSession` needs `sessions.freshFor` in the auth definition.',
    );
  }
  const age = Date.now() - session.createdAt.getTime();
  return age < freshFor * 1000 ? { principal: ctx.principal } : SessionNotFresh({ freshFor });
}
