/**
 * Type definitions for the Dot Auth module
 */

import type { User as BetterAuthUser, Session as BetterAuthSession } from 'better-auth';

// Re-export better-auth types for convenience
export type { BetterAuthUser, BetterAuthSession };

/**
 * Extended user type with RBAC support
 */
export interface DotUser extends BetterAuthUser {
  roles?: Role[];
  permissions?: Permission[];
  attributes?: Record<string, any>;
}

/**
 * Extended session type
 */
export interface DotSession extends BetterAuthSession {
  user: DotUser;
}

/**
 * Role definition
 */
export interface Role {
  id: string;
  name: string;
  description?: string;
  permissions?: Permission[];
  isSystem?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Permission definition
 */
export interface Permission {
  id: string;
  resource: string;
  action: string;
  description?: string;
  conditions?: Record<string, any>;
}

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
export interface CustomProvider {
  id: string;
  type: 'oauth' | 'oidc' | 'custom';
  config: Record<string, any>;
}

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
export interface AuthEvent<T = any> {
  type: string;
  user?: DotUser;
  session?: DotSession;
  data?: T;
  timestamp: Date;
}

export interface SignInEvent extends AuthEvent {
  type: 'signIn';
  provider: string;
  isNewUser: boolean;
}

export interface SignUpEvent extends AuthEvent {
  type: 'signUp';
  provider: string;
}

export interface SignOutEvent extends AuthEvent {
  type: 'signOut';
}

export interface PasswordResetEvent extends AuthEvent {
  type: 'passwordReset';
}

export interface EmailVerificationEvent extends AuthEvent {
  type: 'emailVerification';
  verified: boolean;
}

export interface MFAEvent extends AuthEvent {
  type: 'mfa';
  action: 'enabled' | 'disabled' | 'verified';
  method: MFAProvider;
}

/**
 * Policy context for ABAC
 */
export interface PolicyContext {
  user: DotUser;
  resource: string;
  action: string;
  environment?: Record<string, any>;
  attributes?: Record<string, any>;
}

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  enabled?: boolean;
  maxAttempts?: number;
  windowMs?: number;
  blockDurationMs?: number;
  skipSuccessfulRequests?: boolean;
}

/**
 * Password policy configuration
 */
export interface PasswordPolicy {
  minLength?: number;
  maxLength?: number;
  requireUppercase?: boolean;
  requireLowercase?: boolean;
  requireNumbers?: boolean;
  requireSymbols?: boolean;
  preventCommon?: boolean;
  preventUserInfo?: boolean;
  customValidator?: (password: string, user?: DotUser) => boolean | string;
}

/**
 * Account lockout configuration
 */
export interface LockoutConfig {
  enabled?: boolean;
  maxAttempts?: number;
  lockoutDurationMs?: number;
  resetAfterMs?: number;
}

/**
 * Cookie options
 */
export interface CookieOptions {
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  httpOnly?: boolean;
  domain?: string;
  path?: string;
}

/**
 * Email template
 */
export interface EmailTemplate {
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
}

/**
 * Email templates collection
 */
export interface EmailTemplates {
  verifyEmail?: EmailTemplate;
  resetPassword?: EmailTemplate;
  magicLink?: EmailTemplate;
  changeEmail?: EmailTemplate;
  mfaCode?: EmailTemplate;
  welcome?: EmailTemplate;
}