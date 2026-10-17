/**
 * `@arki/auth` — the browser-safe vocabulary: `defineAuth`, the error codes, the constants and the
 * principal and definition types. No engine, no Drizzle, no Zod: a client bundle can import it.
 * The server builds the auth with `createAuth` from `@arki/auth/pg`.
 */
export { defineAuth } from './definition.js';
export type {
  AccountOptions,
  AuthDefinition,
  AuthMethod,
  IdTokenMethod,
  IdTokenMethodsOf,
  Seconds,
  SocialMethod,
  VerifyEmailMode,
  WorkspacesOption,
} from './definition.js';
export type { AnyPrincipal, AuthContext, Principal, PrincipalOf, PrincipalSession, PrincipalVia } from './principal.js';
export { AUTH_ERROR_CODES, AuthError, isAuthError } from './errors.js';
export type { AuthErrorCode } from './errors.js';
export { AUTH_SECRET_MIN_LENGTH, PASSWORD_MIN_LENGTH } from './constants.js';
export type { UserId } from '@arki/contracts';
