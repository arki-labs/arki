import { betterAuth as _betterAuth } from 'better-auth';

/**
 * Wrapper around Better Auth that syncs the secret to BETTER_AUTH_SECRET.
 *
 * Better Auth reads process.env.BETTER_AUTH_SECRET internally even when
 * secret is passed explicitly in config. This wrapper ensures the env var
 * is always in sync so you only need to set AUTH_SECRET in your deployment.
 */
export const betterAuth: typeof _betterAuth = (config) => {
  if (typeof config.secret === 'string') {
    process.env.BETTER_AUTH_SECRET = config.secret;
  }
  return _betterAuth(config);
};
