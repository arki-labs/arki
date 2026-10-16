/**
 * `@arki/auth/http` — the principal as an `@arki/http` deriver. Node and Bun.
 *
 * @example
 * routes().derive(withPrincipal(auth)).bind(getProfile, (_input, ctx) => repo.byUser(ctx.principal.user.id));
 */
import type { Deriver } from '@arki/http';
import { derive, HttpError } from '@arki/http';

import type { AnyPrincipal } from './principal.js';
import { AUTH_ERROR_CODES, isAuthError } from './errors.js';

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

/** `ctx.principal` for signed-in callers; a guest gets 401, a refused check 403. */
export function withPrincipal<P extends AnyPrincipal>(
  auth: PrincipalSource<P>,
  options: WithPrincipalOptions = {},
): Deriver<'principal', P> {
  return derive('principal', async request => {
    const principal = await resolve(auth, request);
    if (principal === null) {
      throw new HttpError(401, AUTH_ERROR_CODES.unauthenticated, 'Sign in to continue.', {
        headers: { 'www-authenticate': 'Bearer' },
      });
    }
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
