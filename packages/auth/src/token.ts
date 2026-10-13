import { randomBytes } from 'node:crypto';

import { debugToken } from './debug';

/**
 * Generates a cryptographically secure random token suitable for session IDs,
 * verification tokens, etc.
 *
 * @param length The desired length of the token in bytes (default: 32 bytes -> 64 hex chars).
 * @returns A hex-encoded random token string.
 */
export const generateSecureToken = (length = 32): string => {
  debugToken.debug('[generateSecureToken] Generating secure token (length: {length} bytes -> {value2} hex chars)', {
    length,
    value2: length * 2,
  });
  const token = randomBytes(length).toString('hex');
  debugToken.debug('[generateSecureToken] Token generated successfully');
  return token;
};
