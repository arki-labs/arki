/**
 * Security utilities and helpers for the auth module
 */

import crypto from 'node:crypto';

import { debugAuth } from '../debug.js';

/**
 * Generate a cryptographically secure random token
 *
 * @param length - The length of the token in bytes (default 32)
 * @returns A hex-encoded secure random token
 */
export function generateSecureToken(length = 32): string {
  debugAuth('[security] Generating secure token (length: %d bytes)', length);
  const token = crypto.randomBytes(length).toString('hex');
  debugAuth('[security] Secure token generated (output length: %d chars)', token.length);
  return token;
}

/**
 * Generate a secure session token
 *
 * @returns A secure session token with timestamp prefix
 */
export function generateSessionToken(): string {
  debugAuth('[security] Generating session token with timestamp');
  const timestamp = Date.now().toString(36);
  const random = generateSecureToken(24);
  const token = `${timestamp}_${random}`;
  debugAuth('[security] Session token generated');
  return token;
}

/**
 * Validate session token format
 *
 * @param token - The token to validate
 * @returns True if token format is valid
 */
export function isValidSessionToken(token: string): boolean {
  debugAuth('[security] Validating session token format');

  if (!token || typeof token !== 'string') {
    debugAuth('[security] Session token validation failed: invalid input type');
    return false;
  }

  // Check for expected format: timestamp_randomhex
  const parts = token.split('_');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    debugAuth('[security] Session token validation failed: invalid format (expected: timestamp_randomhex)');
    return false;
  }

  // Validate timestamp part (base36)
  if (!/^[0-9a-z]+$/.test(parts[0])) {
    debugAuth('[security] Session token validation failed: invalid timestamp part');
    return false;
  }

  // Validate random part (hex)
  if (!/^[0-9a-f]+$/.test(parts[1])) {
    debugAuth('[security] Session token validation failed: invalid random part');
    return false;
  }

  debugAuth('[security] Session token validation successful');
  return true;
}

/**
 * Hash a token for secure storage
 *
 * @param token - The token to hash
 * @returns The hashed token
 */
export function hashToken(token: string): string {
  debugAuth('[security] Hashing token using SHA-256');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  debugAuth('[security] Token hashed successfully');
  return hash;
}

/**
 * Compare a plain token with a hashed token
 *
 * @param plainToken - The plain token
 * @param hashedToken - The hashed token to compare against
 * @returns True if tokens match
 */
export function compareTokens(plainToken: string, hashedToken: string): boolean {
  debugAuth('[security] Comparing tokens (timing-safe)');
  const hashedPlain = hashToken(plainToken);
  // Use timing-safe comparison
  const match = crypto.timingSafeEqual(Buffer.from(hashedPlain), Buffer.from(hashedToken));
  debugAuth('[security] Token comparison result: %s', match ? 'match' : 'no match');
  return match;
}

/**
 * Sanitize user input to prevent injection attacks
 *
 * @param input - The input to sanitize
 * @returns Sanitized input
 */
export function sanitizeInput(input: string): string {
  if (!input || typeof input !== 'string') {
    debugAuth('[security] Sanitize: invalid input type, returning empty string');
    return '';
  }

  const originalLength = input.length;
  debugAuth('[security] Sanitizing input (original length: %d)', originalLength);

  // Remove null bytes
  let sanitized = input.replaceAll('\0', '');

  // Trim whitespace
  sanitized = sanitized.trim();

  // Limit length to prevent DoS
  const MAX_INPUT_LENGTH = 1000;
  if (sanitized.length > MAX_INPUT_LENGTH) {
    debugAuth('[security] Input truncated from %d to %d chars (DoS prevention)', sanitized.length, MAX_INPUT_LENGTH);
    sanitized = sanitized.slice(0, Math.max(0, MAX_INPUT_LENGTH));
  }

  debugAuth('[security] Input sanitized (final length: %d)', sanitized.length);
  return sanitized;
}

/**
 * Validate email format
 *
 * @param email - The email to validate
 * @returns True if email format is valid
 */
export function isValidEmail(email: string): boolean {
  debugAuth('[security] Validating email format');

  if (!email || typeof email !== 'string') {
    debugAuth('[security] Email validation failed: invalid input type');
    return false;
  }

  // Basic email validation regex
  const emailRegex = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;

  // Check basic format
  if (!emailRegex.test(email)) {
    debugAuth('[security] Email validation failed: invalid format');
    return false;
  }

  // Check reasonable length
  if (email.length > 254) {
    // RFC 5321
    debugAuth('[security] Email validation failed: exceeds max length (254 chars)');
    return false;
  }

  debugAuth('[security] Email validation successful');
  return true;
}

/**
 * Rate limiting configuration
 */
export type RateLimitConfig = {
  /**
   * Maximum number of attempts
   */
  maxAttempts: number;

  /**
   * Time window in seconds
   */
  windowSeconds: number;

  /**
   * Lockout duration in seconds after max attempts
   */
  lockoutSeconds?: number;
};

/**
 * Default rate limit configurations
 */
export const rateLimitDefaults = {
  /**
   * Login attempts rate limit
   */
  login: {
    maxAttempts: 5,
    windowSeconds: 60 * 10, // 10 minutes
    lockoutSeconds: 60 * 30, // 30 minutes
  } as RateLimitConfig,

  /**
   * Password reset rate limit
   */
  passwordReset: {
    maxAttempts: 3,
    windowSeconds: 60 * 60, // 1 hour
    lockoutSeconds: 60 * 60 * 24, // 24 hours
  } as RateLimitConfig,

  /**
   * API request rate limit
   */
  api: {
    maxAttempts: 100,
    windowSeconds: 60, // 1 minute
  } as RateLimitConfig,

  /**
   * Session creation rate limit
   */
  sessionCreation: {
    maxAttempts: 10,
    windowSeconds: 60 * 60, // 1 hour
    lockoutSeconds: 60 * 60 * 2, // 2 hours
  } as RateLimitConfig,
};

/**
 * Create a rate limiter key
 *
 * @param prefix - The key prefix (e.g., 'login', 'reset')
 * @param identifier - The identifier (e.g., email, IP address)
 * @returns A rate limiter key
 */
export function createRateLimitKey(prefix: string, identifier: string): string {
  debugAuth('[security] Creating rate limit key (prefix: %s)', prefix);
  const sanitized = sanitizeInput(identifier);
  const hashed = hashToken(sanitized);
  const key = `rate_limit:${prefix}:${hashed}`;
  debugAuth('[security] Rate limit key created');
  return key;
}

/**
 * Security headers for auth endpoints
 */
export const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'",
} as const;

/**
 * Validate password strength
 *
 * @param password - The password to validate
 * @param policy - Optional password policy
 * @returns Validation result with any error messages
 */
export function validatePassword(
  password: string,
  policy?: {
    minLength?: number;
    requireUppercase?: boolean;
    requireLowercase?: boolean;
    requireNumbers?: boolean;
    requireSymbols?: boolean;
  },
): { valid: boolean; errors: string[] } {
  debugAuth('[security] Validating password strength');
  const errors: string[] = [];
  const defaultPolicy = {
    minLength: 8,
    requireUppercase: false,
    requireLowercase: false,
    requireNumbers: false,
    requireSymbols: false,
  };

  const appliedPolicy = { ...defaultPolicy, ...policy };
  debugAuth(
    '[security] Applied policy: minLength=%d, uppercase=%s, lowercase=%s, numbers=%s, symbols=%s',
    appliedPolicy.minLength,
    appliedPolicy.requireUppercase,
    appliedPolicy.requireLowercase,
    appliedPolicy.requireNumbers,
    appliedPolicy.requireSymbols,
  );

  if (!password || typeof password !== 'string') {
    debugAuth('[security] Password validation failed: invalid input');
    errors.push('Password is required');
    return { valid: false, errors };
  }

  if (password.length < appliedPolicy.minLength) {
    debugAuth('[security] Password validation failed: too short (%d < %d)', password.length, appliedPolicy.minLength);
    errors.push(`Password must be at least ${appliedPolicy.minLength} characters`);
  }

  if (appliedPolicy.requireUppercase && !/[A-Z]/.test(password)) {
    debugAuth('[security] Password validation failed: missing uppercase');
    errors.push('Password must contain at least one uppercase letter');
  }

  if (appliedPolicy.requireLowercase && !/[a-z]/.test(password)) {
    debugAuth('[security] Password validation failed: missing lowercase');
    errors.push('Password must contain at least one lowercase letter');
  }

  if (appliedPolicy.requireNumbers && !/\d/.test(password)) {
    debugAuth('[security] Password validation failed: missing numbers');
    errors.push('Password must contain at least one number');
  }

  if (appliedPolicy.requireSymbols && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    debugAuth('[security] Password validation failed: missing symbols');
    errors.push('Password must contain at least one special character');
  }

  debugAuth(
    '[security] Password validation complete: %s (%d error(s))',
    errors.length === 0 ? 'valid' : 'invalid',
    errors.length,
  );
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Add random delay to prevent timing attacks
 *
 * @param minMs - Minimum delay in milliseconds
 * @param maxMs - Maximum delay in milliseconds
 * @returns Promise that resolves after the delay
 */
export async function addSecurityDelay(minMs = 100, maxMs = 500): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  debugAuth('[security] Adding random security delay: %d ms (range: %d-%d ms)', delay, minMs, maxMs);
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Constant-time string comparison to prevent timing attacks
 *
 * @param a - First string
 * @param b - Second string
 * @returns True if strings are equal
 */
export function secureCompare(a: string, b: string): boolean {
  debugAuth('[security] Performing constant-time string comparison');

  if (typeof a !== 'string' || typeof b !== 'string') {
    debugAuth('[security] Secure compare failed: invalid input types');
    return false;
  }

  // Ensure both strings are the same length for constant-time comparison
  const lengthA = Buffer.byteLength(a);
  const lengthB = Buffer.byteLength(b);

  if (lengthA !== lengthB) {
    debugAuth('[security] Secure compare failed: length mismatch (%d vs %d bytes)', lengthA, lengthB);
    return false;
  }

  const match = crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  debugAuth('[security] Secure compare result: %s', match ? 'match' : 'no match');
  return match;
}
