import { getLogger } from '@arki/log';

/**
 * Debug logger for authentication operations
 * Enable with: DEBUG=auth:core
 */
export const debugAuth = getLogger('auth:core');

/**
 * Debug logger for password operations
 * Enable with: DEBUG=auth:password
 */
export const debugPassword = getLogger('auth:password');

/**
 * Debug logger for token operations
 * Enable with: DEBUG=auth:token
 */
export const debugToken = getLogger('auth:token');

/**
 * Debug logger for email verification operations
 * Enable with: DEBUG=auth:email
 */
export const debugEmail = getLogger('auth:email');

/**
 * Debug logger for rate limiting operations
 * Enable with: DEBUG=auth:ratelimit
 */
export const debugRateLimit = getLogger('auth:ratelimit');

/**
 * Enable all auth debug logs
 * Enable with: DEBUG=auth:*
 */
