import { betterAuth as _betterAuth } from 'better-auth';

/** Shortest auth secret accepted in production. Matches Better Auth's own warning threshold. */
export const AUTH_SECRET_MIN_LENGTH = 32;

/**
 * Refuse a missing or short auth secret in production.
 *
 * The secret signs session cookies and verification tokens. A short or leaked
 * one lets an attacker forge a session for any user. Better Auth only warns
 * below 32 characters, so this check turns the warning into an error.
 * Outside production the check is skipped, so local dev and tests can use any secret.
 */
export function assertAuthSecret(secret: string | undefined, nodeEnv: string | undefined): void {
  if (nodeEnv !== 'production') return;
  if (!secret) {
    throw new Error('[@arki/auth] The auth secret is missing. Pass `secret` (for example from AUTH_SECRET).');
  }
  if (secret.length < AUTH_SECRET_MIN_LENGTH) {
    throw new Error(
      `[@arki/auth] The auth secret is too short (${secret.length} characters). ` +
        `Production needs at least ${AUTH_SECRET_MIN_LENGTH}. Generate one with \`openssl rand -base64 32\`.`,
    );
  }
}

/**
 * Better Auth with a production check on the secret.
 *
 * The secret travels only through `config.secret`, so each instance keeps its
 * own. Nothing here writes `process.env`, and two instances built in the same
 * process with different secrets never see each other's sessions.
 */
export const betterAuth: typeof _betterAuth = config => {
  assertAuthSecret(config.secret, process.env.NODE_ENV);
  return _betterAuth(config);
};
