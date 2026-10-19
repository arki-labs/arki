/** Canonical auth refusals shared by transport declarations and callers. */
import { z } from 'zod';

import { defineFailure, UnexpectedDefect } from '@arki/failure';

import type { AnyPrincipal } from './principal.js';
import { AUTH_ERROR_CODES, isAuthError } from './errors.js';

/**
 * No valid session, expired credentials, or conflicting credentials.
 * @fix Sign in and send one credential per request.
 * @verify bun run test -- src/http.test.ts
 */
export const AuthenticationRequired = defineFailure('auth.unauthenticated', {
  status: 401,
  message: 'Sign in to continue.',
});

/**
 * A signed-in caller lacks the required permission or verified email.
 * @fix Verify the email or use an account with the required permission.
 * @verify bun run test -- src/orpc-guards.test.ts
 */
export const AccessDenied = defineFailure('auth.forbidden', {
  status: 403,
  message: 'You do not have access to this.',
});

/**
 * Missing and hidden subjects have exactly the same public refusal.
 * @fix Check the resource identifier and account access.
 * @verify bun run test -- src/http-policies.test.ts
 */
export const ResourceMissing = defineFailure('auth.not_found', {
  status: 404,
  message: 'Resource not found.',
});

/**
 * The caller must wait before another authentication attempt.
 * @fix Wait the retryAfter seconds before trying again.
 * @verify bun run test -- src/http.test.ts
 */
export const AuthenticationRateLimited = defineFailure('auth.rate_limited', {
  status: 429,
  data: z.object({ retryAfter: z.number().finite().nonnegative().optional() }),
  message: 'Too many authentication attempts.',
});

/**
 * The authentication store cannot safely serve this request.
 * @fix Restore the authentication store and retry.
 * @verify bun run test -- src/pg/security/rate-limit.test.ts
 */
export const AuthenticationUnavailable = defineFailure('auth.unavailable', {
  status: 503,
  message: 'Authentication is temporarily unavailable.',
});

/** Definitions for route.failures, errorMap and client revival. */
export const AUTH_FAILURES = [
  AuthenticationRequired,
  AccessDenied,
  ResourceMissing,
  AuthenticationRateLimited,
  AuthenticationUnavailable,
  UnexpectedDefect,
] as const;

/** The principal reader only; no second authentication engine. */
export type PrincipalSource<P extends AnyPrincipal> = {
  readonly principal: (headers: Headers) => Promise<P | null>;
};

export type PrincipalChecks = {
  readonly verified?: boolean;
  readonly role?: string;
};

/** Translate the engine's request errors once; causes stay private. */
export async function resolvePrincipal<P extends AnyPrincipal>(auth: PrincipalSource<P>, headers: Headers) {
  try {
    return await auth.principal(headers);
  } catch (error) {
    if (isAuthError(error)) {
      if (error.code === AUTH_ERROR_CODES.unauthenticated) return AuthenticationRequired({ cause: error });
      if (error.code === AUTH_ERROR_CODES.forbidden) return AccessDenied({ cause: error });
      if (error.code === AUTH_ERROR_CODES.rateLimited) {
        return AuthenticationRateLimited(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }, {
          cause: error,
        });
      }
      if (error.code === AUTH_ERROR_CODES.storeUnavailable) return AuthenticationUnavailable({ cause: error });
    }
    return UnexpectedDefect({ cause: error });
  }
}

/** Require a principal, preserving its app-declared type. */
export function requirePrincipal<P extends AnyPrincipal>(principal: P | null) {
  return principal === null ? AuthenticationRequired() : principal;
}

/** Check the existing principal without reading credentials or loading data. */
export function checkPrincipal<P extends AnyPrincipal>(principal: P | null, options: PrincipalChecks = {}) {
  if (principal === null) return AuthenticationRequired();
  if (options.verified === true && !principal.user.emailVerified) return AccessDenied();
  if (options.role !== undefined && !principal.roles.includes(options.role)) return AccessDenied();
  return principal;
}

/** Exact canonical predicate; callers keep their success type without widening to Failure. */
export function isAuthBoundaryFailure(value: unknown): value is ReturnType<(typeof AUTH_FAILURES)[number]> {
  return AUTH_FAILURES.some(definition => definition.is(value));
}

/** Required by signed-in principal guards. */
export const AUTH_PRINCIPAL_FAILURES = [AuthenticationRequired, AccessDenied] as const;
/** Required by policy guards; missing and denied visibility use one definition. */
export const AUTH_POLICY_FAILURES = [...AUTH_PRINCIPAL_FAILURES, ResourceMissing] as const;
