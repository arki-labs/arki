/**
 * The environment variables of a Foreman v2 target (RFC § 3.3), and how they
 * become handler config. Foreman v2 is OFF until the keys are set: an app
 * created from a template boots without them and answers 404 on `/api/foreman`.
 */
import { z } from '@arki/contracts';

import type { CreateForemanHandlerOptions } from './dispatcher.ts';
import type { ForemanEnvironment } from './protocol.ts';
import { ADMIN_ERROR_CODES, AdminError } from './errors.ts';
import { foremanEnvironmentSchema, writesModeSchema } from './protocol.ts';

/**
 * Spread into the app's env schema (`defineEnv({ server: { ...foremanEnvShape } })`).
 * Every key is optional so an app without Foreman keys still boots.
 */
export const foremanEnvShape = {
  /** App slug, e.g. `shop`. With the environment it forms the audience `shop:prod`. */
  FOREMAN_APP_ID: z.string().min(1).optional(),
  /** This app's identity key (PKCS#8, base64url). Signs every response. */
  FOREMAN_APP_KEY: z.string().min(1).optional(),
  /** Foreman's read public key (base64url Ed25519). */
  FOREMAN_READ_KEY: z.string().min(1).optional(),
  /** Overlap key while rotating the read key. */
  FOREMAN_READ_KEY_NEXT: z.string().min(1).optional(),
  /** Foreman's execute public key. Must differ from the read key. */
  FOREMAN_EXECUTE_KEY: z.string().min(1).optional(),
  FOREMAN_EXECUTE_KEY_NEXT: z.string().min(1).optional(),
  /** `prod`, `staging` or `dev`. Overrides what `foremanEnvironmentFromNodeEnv` derives from NODE_ENV (set it to `staging` on a staging deploy). */
  FOREMAN_ENVIRONMENT: foremanEnvironmentSchema.optional(),
  /** `on` allows executes. Anything else, or unset, refuses every execute. */
  FOREMAN_WRITES: writesModeSchema.optional(),
};

/** The `FOREMAN_*` part of a validated env: exactly what `foremanEnvShape` parses to, every key optional. */
export type ForemanEnv = z.output<z.ZodObject<typeof foremanEnvShape>>;

/**
 * The Foreman environment an app runs as. `FOREMAN_ENVIRONMENT` wins; otherwise
 * `production` is `prod` and anything else (`development`, `test`, unset) is `dev`.
 */
export function foremanEnvironmentFromNodeEnv(
  nodeEnv: string | undefined,
  override?: ForemanEnvironment,
): ForemanEnvironment {
  return override ?? (nodeEnv === 'production' ? 'prod' : 'dev');
}

/** The handler config the env describes. */
export type ForemanEnvConfig = Pick<CreateForemanHandlerOptions<never>, 'identity' | 'keys' | 'writes'> & {
  appId: string;
};

/**
 * Turn env into handler config. Returns `undefined` when no Foreman variable
 * is set (v2 off). Throws `ARKI_ADMIN_E014` when only some are set, so a typo
 * in one key cannot leave a half-configured target.
 */
export function foremanConfigFromEnv(env: ForemanEnv, environment: ForemanEnvironment): ForemanEnvConfig | undefined {
  const required = ['FOREMAN_APP_ID', 'FOREMAN_APP_KEY', 'FOREMAN_READ_KEY', 'FOREMAN_EXECUTE_KEY'] as const;
  const missing = required.filter(name => env[name] === undefined);
  if (missing.length === required.length) return undefined;
  const {
    FOREMAN_APP_ID: appId,
    FOREMAN_APP_KEY: privateKey,
    FOREMAN_READ_KEY: read,
    FOREMAN_EXECUTE_KEY: execute,
  } = env;
  if (appId === undefined || privateKey === undefined || read === undefined || execute === undefined) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidConfig,
      `Foreman is partly configured. Missing: ${missing.join(', ')}.`,
      'Set all of FOREMAN_APP_ID, FOREMAN_APP_KEY, FOREMAN_READ_KEY and FOREMAN_EXECUTE_KEY, or none of them.',
    );
  }
  return {
    appId,
    identity: { aud: `${appId}:${environment}`, privateKey },
    keys: {
      read: { current: read, next: env.FOREMAN_READ_KEY_NEXT },
      execute: { current: execute, next: env.FOREMAN_EXECUTE_KEY_NEXT },
    },
    writes: env.FOREMAN_WRITES ?? 'off',
  };
}
