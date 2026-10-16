export { AUTH_SECRET_MIN_LENGTH, assertAuthSecret, betterAuth } from './create-auth';
export { defineAuthBackend, createPrefixedIdHook } from './define-auth-backend';
export type { DefineAuthBackendOptions, DefinedAuth, GenerateIdHook } from './define-auth-backend';
export { ResendProvider } from './email/resendAuthProvider';
export * from './ids';
export { tweaksColumn, EMPTY_TWEAKS } from './tweaks-column';
export { PASSWORD_MIN_LENGTH } from './constants';

export { defineAuth } from './definition';
export type {
  AccountOptions,
  AuthDefinition,
  AuthMethod,
  Seconds,
  SocialMethod,
  VerifyEmailMode,
  WorkspacesOption,
} from './definition';
export type { AnyPrincipal, AuthContext, Principal, PrincipalOf, PrincipalSession, PrincipalVia } from './principal';
export { AUTH_ERROR_CODES, AuthError, isAuthError } from './errors';
export type { AuthErrorCode } from './errors';
