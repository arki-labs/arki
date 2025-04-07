import { randomBytes } from 'node:crypto';

/**
 * Generates a cryptographically secure random token suitable for session IDs,
 * verification tokens, etc.
 *
 * @param length The desired length of the token in bytes (default: 32 bytes -> 64 hex chars).
 * @returns A hex-encoded random token string.
 */
export const generateSecureToken = (length = 32): string => {
  return randomBytes(length).toString('hex');
};
