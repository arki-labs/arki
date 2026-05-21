import { createDebugLogger } from '@arki/log/debug';

/**
 * Debug logger for authentication operations
 * Enable with: DEBUG=auth:core
 */
export const debugAuth = createDebugLogger('auth:core');

/**
 * Debug logger for password operations
 * Enable with: DEBUG=auth:password
 */
export const debugPassword = createDebugLogger('auth:password');

/**
 * Debug logger for token operations
 * Enable with: DEBUG=auth:token
 */
export const debugToken = createDebugLogger('auth:token');

/**
 * Debug logger for email verification operations
 * Enable with: DEBUG=auth:email
 */
export const debugEmail = createDebugLogger('auth:email');

/**
 * Debug logger for rate limiting operations
 * Enable with: DEBUG=auth:ratelimit
 */
export const debugRateLimit = createDebugLogger('auth:ratelimit');

/**
 * Enable all auth debug logs
 * Enable with: DEBUG=auth:*
 */
