/**
 * Type definitions for the Dot Auth module
 */

import type { Session as BetterAuthSession, User as BetterAuthUser } from 'better-auth';

// Re-export better-auth types for convenience

/**
 * Extended user type with RBAC support
 */
export type DotUser = {
  roles?: Role[];
  permissions?: Permission[];
  attributes?: Record<string, any>;
} & BetterAuthUser;

/**
 * Extended session type
 */
export type DotSession = {
  user: DotUser;
} & BetterAuthSession;

/**
 * Role definition
 */
export type Role = {
  id: string;
  name: string;
  description?: string;
  permissions?: Permission[];
  isSystem?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

/**
 * Permission definition
 */
export type Permission = {
  id: string;
  resource: string;
  action: string;
  description?: string;
  conditions?: Record<string, any>;
};

/**
 * Provider types
 */
export type BuiltInProvider =
  | 'google'
  | 'github'
  | 'discord'
  | 'facebook'
  | 'apple'
  | 'twitter'
  | 'linkedin'
  | 'magicLink'
  | 'credentials';

/**
 * Custom provider configuration
 */
export type CustomProvider = {
  id: string;
  type: 'oauth' | 'oidc' | 'custom';
  config: Record<string, any>;
};

/**
 * Email provider types
 */
export type EmailProvider = 'resend' | 'sendgrid' | 'ses' | 'smtp' | 'postmark';

/**
 * Password hasher types
 */
export type PasswordHasher = 'argon2' | 'bcrypt' | 'scrypt';

/**
 * Session strategy types
 */
export type SessionStrategy = 'jwt' | 'database';

/**
 * MFA provider types
 */
export type MFAProvider = 'totp' | 'sms' | 'email' | 'webauthn';

/**
 * Auth event types for hooks
 */
export type AuthEvent<T = any> = {
  type: string;
  user?: DotUser;
  session?: DotSession;
  data?: T;
  timestamp: Date;
};

export type SignInEvent = {
  type: 'signIn';
  provider: string;
  isNewUser: boolean;
} & AuthEvent;

export type SignUpEvent = {
  type: 'signUp';
  provider: string;
} & AuthEvent;

export type SignOutEvent = {
  type: 'signOut';
} & AuthEvent;

export type PasswordResetEvent = {
  type: 'passwordReset';
} & AuthEvent;

export type EmailVerificationEvent = {
  type: 'emailVerification';
  verified: boolean;
} & AuthEvent;

export type MFAEvent = {
  type: 'mfa';
  action: 'enabled' | 'disabled' | 'verified';
  method: MFAProvider;
} & AuthEvent;

/**
 * Policy context for ABAC
 */
export type PolicyContext = {
  user: DotUser;
  resource: string;
  action: string;
  environment?: Record<string, any>;
  attributes?: Record<string, any>;
};

/**
 * Rate limit configuration
 */
export type RateLimitConfig = {
  enabled?: boolean;
  maxAttempts?: number;
  windowMs?: number;
  blockDurationMs?: number;
  skipSuccessfulRequests?: boolean;
};

/**
 * Password policy configuration
 */
export type PasswordPolicy = {
  minLength?: number;
  maxLength?: number;
  requireUppercase?: boolean;
  requireLowercase?: boolean;
  requireNumbers?: boolean;
  requireSymbols?: boolean;
  preventCommon?: boolean;
  preventUserInfo?: boolean;
  customValidator?: (password: string, user?: DotUser) => boolean | string;
};

/**
 * Account lockout configuration
 */
export type LockoutConfig = {
  enabled?: boolean;
  maxAttempts?: number;
  lockoutDurationMs?: number;
  resetAfterMs?: number;
};

/**
 * Cookie options
 */
export type CookieOptions = {
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  httpOnly?: boolean;
  domain?: string;
  path?: string;
};

/**
 * Email template
 */
export type EmailTemplate = {
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
};

/**
 * Email templates collection
 */
export type EmailTemplates = {
  verifyEmail?: EmailTemplate;
  resetPassword?: EmailTemplate;
  magicLink?: EmailTemplate;
  changeEmail?: EmailTemplate;
  mfaCode?: EmailTemplate;
  welcome?: EmailTemplate;
};
export { type Session as BetterAuthSession, type User as BetterAuthUser } from 'better-auth';
