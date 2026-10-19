/**
 * `@arki/auth` — the browser-safe vocabulary: `defineAuth`, `definePolicies`, the error codes, the
 * constants and the principal and definition types. No engine or Drizzle: a client bundle
 * can import it. The server builds the auth with `createAuth` from `@arki/auth/pg`.
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
export { definePolicies } from './policies.js';
export type {
  AnyPolicies,
  GroupOf,
  Loaded,
  Policies,
  PoliciesFor,
  Policy,
  PolicyArgs,
  PolicyName,
  PolicyTree,
  PrincipalOfPolicies,
  RefusalOutcome,
  SubjectOf,
} from './policies.js';
export { AUTH_ERROR_CODES, AuthError, isAuthError } from './errors.js';
export type { AuthErrorCode } from './errors.js';
export { AUTH_SECRET_MIN_LENGTH, PASSWORD_MIN_LENGTH } from './constants.js';
export type { UserId } from '@arki/contracts';

export {
  AUTH_FAILURES,
  AUTH_PRINCIPAL_FAILURES,
  AUTH_POLICY_FAILURES,
  isAuthBoundaryFailure,
  AuthenticationRequired,
  AccessDenied,
  ResourceMissing,
  AuthenticationRateLimited,
  AuthenticationUnavailable,
  resolvePrincipal,
  requirePrincipal,
  checkPrincipal,
} from './boundary-failures.js';
export type { PrincipalSource, PrincipalChecks } from './boundary-failures.js';
export { authorizePolicy } from './policies.js';
