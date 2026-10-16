import { AUTH_SECRET_MIN_LENGTH } from '../constants.js';
import { AUTH_ERROR_CODES, AuthError } from '../errors.js';

/**
 * Refuses a missing or short secret in production (`ARKI_AUTH_E002`). The secret signs session
 * cookies and tokens; a short or leaked one lets an attacker forge a session for any user. Better
 * Auth only warns, so this turns the warning into an error. Outside production any secret passes,
 * so local dev and tests can use their own.
 */
export function assertAuthSecret(secret: string | undefined, production: boolean): void {
  if (!production) return;
  if (secret === undefined || secret === '') {
    throw new AuthError(
      AUTH_ERROR_CODES.weakSecret,
      '[@arki/auth] The auth secret is missing. Set `runtime().secret`.',
    );
  }
  if (secret.length < AUTH_SECRET_MIN_LENGTH) {
    throw new AuthError(
      AUTH_ERROR_CODES.weakSecret,
      `[@arki/auth] The auth secret is too short (${secret.length} characters). Production needs at least ` +
        `${AUTH_SECRET_MIN_LENGTH}. Generate one with \`openssl rand -base64 32\`.`,
    );
  }
}
