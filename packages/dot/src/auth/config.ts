/**
 * Configuration interfaces for Dot Auth module
 */

import type {
  BuiltInProvider,
  CookieOptions,
  CustomProvider,
  DotUser,
  EmailProvider,
  EmailTemplates,
  EmailVerificationEvent,
  LockoutConfig,
  MFAEvent,
  MFAProvider,
  PasswordHasher,
  PasswordPolicy,
  PasswordResetEvent,
  Permission,
  RateLimitConfig,
  SessionStrategy,
  SignInEvent,
  SignOutEvent,
  SignUpEvent,
} from './types';

/**
 * Main Dot Auth configuration
 */
export type DotAuthConfig = {
  /**
   * Application name for auth
   */
  appName?: string;

  /**
   * Application key for cookie prefixing
   */
  appKey?: string;

  /**
   * Base URL for auth callbacks
   */
  baseUrl?: string;

  /**
   * Production URL for OAuth proxy
   */
  productionUrl?: string;

  /**
   * Auth secret (will use env.AUTH_SECRET if not provided)
   */
  secret?: string;

  /**
   * Authentication providers
   */
  providers?: (BuiltInProvider | CustomProvider)[];

  /**
   * Session configuration
   */
  session?: SessionConfig;

  /**
   * Email configuration
   */
  email?: EmailConfig;

  /**
   * RBAC configuration
   */
  rbac?: RBACConfig;

  /**
   * MFA configuration
   */
  mfa?: MFAConfig;

  /**
   * Security configuration
   */
  security?: SecurityConfig;

  /**
   * Hooks for auth events
   */
  hooks?: AuthHooks;

  /**
   * Custom database adapter (if not using default Drizzle)
   */
  database?: any;

  /**
   * Trusted origins for CORS
   */
  trustedOrigins?: string[];

  /**
   * Enable/disable features
   */
  features?: AuthFeatures;
}

/**
 * Session configuration
 */
export type SessionConfig = {
  /**
   * Session strategy
   */
  strategy?: SessionStrategy;

  /**
   * Session expiry time (e.g., '30d', '1h', '60m')
   */
  expiresIn?: string | number;

  /**
   * Update session expiry on activity
   */
  updateAge?: string | number;

  /**
   * Cookie options
   */
  cookieOptions?: CookieOptions;

  /**
   * Cookie name prefix
   */
  cookiePrefix?: string;

  /**
   * Enable secure cookies (auto-detected in production)
   */
  secure?: boolean;
}

/**
 * Email configuration
 */
export type EmailConfig = {
  /**
   * Default from address
   */
  from: string;

  /**
   * Email provider
   */
  provider?: EmailProvider;

  /**
   * Provider configuration (API keys, etc.)
   */
  config?: Record<string, any>;

  /**
   * Email templates
   */
  templates?: EmailTemplates;

  /**
   * Enable email verification
   */
  verification?: boolean;

  /**
   * Auto sign-in after email verification
   */
  autoSignInAfterVerification?: boolean;
}

/**
 * RBAC configuration
 */
export type RBACConfig = {
  /**
   * Enable RBAC
   */
  enabled?: boolean;

  /**
   * Available roles
   */
  roles?: string[] | RoleDefinition[];

  /**
   * Default role for new users
   */
  defaultRole?: string | RoleDefinition;

  /**
   * Permission schema
   */
  permissions?: PermissionSchema;

  /**
   * Enable attribute-based access control
   */
  abac?: boolean;

  /**
   * Custom policy evaluator
   */
  policyEvaluator?: (context: any) => Promise<boolean>;
}

/**
 * Role definition
 */
export type RoleDefinition = {
  name: string;
  description?: string;
  permissions?: string[] | Permission[];
  isDefault?: boolean;
  isSystem?: boolean;
}

/**
 * Permission schema
 */
export type PermissionSchema = {
  resources: string[];
  actions: string[];
  conditions?: Record<string, any>;
}

/**
 * MFA configuration
 */
export type MFAConfig = {
  /**
   * Available MFA providers
   */
  providers?: MFAProvider[];

  /**
   * Require MFA for all users or specific condition
   */
  required?: boolean | ((user: DotUser) => boolean);

  /**
   * Grace period before MFA is enforced (in days)
   */
  gracePeriod?: number;

  /**
   * Allow users to disable MFA
   */
  allowDisable?: boolean;

  /**
   * Backup codes configuration
   */
  backupCodes?: {
    enabled?: boolean;
    count?: number;
    length?: number;
  };
}

/**
 * Security configuration
 */
export type SecurityConfig = {
  /**
   * Rate limiting configuration
   */
  rateLimit?: RateLimitConfig;

  /**
   * Password policy
   */
  passwordPolicy?: PasswordPolicy;

  /**
   * Account lockout configuration
   */
  accountLockout?: LockoutConfig;

  /**
   * Enable CSRF protection
   */
  csrf?: boolean;

  /**
   * IP allowlist/blocklist
   */
  ipRestrictions?: {
    allowlist?: string[];
    blocklist?: string[];
  };

  /**
   * Session security
   */
  session?: {
    /**
     * Invalidate sessions on password change
     */
    invalidateOnPasswordChange?: boolean;

    /**
     * Maximum concurrent sessions
     */
    maxConcurrent?: number;

    /**
     * Device fingerprinting
     */
    deviceFingerprint?: boolean;

    /**
     * Validate IP address
     */
    validateIp?: boolean;
  };
}

/**
 * Auth features toggles
 */
export type AuthFeatures = {
  /**
   * Enable email/password authentication
   */
  emailPassword?: boolean;

  /**
   * Enable account linking
   */
  accountLinking?: boolean;

  /**
   * Enable user profile updates
   */
  profileUpdate?: boolean;

  /**
   * Enable email change
   */
  emailChange?: boolean;

  /**
   * Enable password reset
   */
  passwordReset?: boolean;

  /**
   * Enable user registration
   */
  registration?: boolean;

  /**
   * Enable social login
   */
  socialLogin?: boolean;

  /**
   * Enable debug mode
   */
  debugMode?: boolean;
}

/**
 * Auth event hooks
 */
export type AuthHooks = {
  /**
   * Called after successful sign in
   */
  onSignIn?: (event: SignInEvent) => Promise<void> | void;

  /**
   * Called after successful sign up
   */
  onSignUp?: (event: SignUpEvent) => Promise<void> | void;

  /**
   * Called after sign out
   */
  onSignOut?: (event: SignOutEvent) => Promise<void> | void;

  /**
   * Called after password reset
   */
  onPasswordReset?: (event: PasswordResetEvent) => Promise<void> | void;

  /**
   * Called after email verification
   */
  onEmailVerification?: (event: EmailVerificationEvent) => Promise<void> | void;

  /**
   * Called after MFA events
   */
  onMFA?: (event: MFAEvent) => Promise<void> | void;

  /**
   * Called before sign in (can prevent sign in by throwing)
   */
  beforeSignIn?: (email: string, provider: string) => Promise<void> | void;

  /**
   * Called before sign up (can prevent sign up by throwing)
   */
  beforeSignUp?: (email: string, provider: string) => Promise<void> | void;
}

/**
 * Provider-specific configurations
 */
export type ProviderConfigs = {
  /**
   * Google OAuth configuration
   */
  google?: {
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
  };

  /**
   * GitHub OAuth configuration
   */
  github?: {
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
  };

  /**
   * Magic link configuration
   */
  magicLink?: {
    expiresIn?: number;
    throttle?: number;
    customToken?: () => string;
  };

  /**
   * Credentials configuration
   */
  credentials?: {
    passwordHasher?: PasswordHasher;
    passwordPolicy?: PasswordPolicy;
    allowSignUp?: boolean;
  };
}
