import { createEnv } from '@t3-oss/env-core';
import type { ZodType } from 'zod';

type CoreEnvConfig = {
  server: Record<string, ZodType>;
  options?: {
    skipValidation?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onValidationError?: (issues: any) => never;
  };
};

export function defineEnv(config: CoreEnvConfig) {
  const skipValidation = config.options?.skipValidation ?? (!!process.env.CI || process.env.NODE_ENV !== 'development');

  // Auto-generate runtimeEnv (no Next.js bundler constraints)
  const runtimeEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(config.server)) {
    runtimeEnv[key] = process.env[key];
  }

  return createEnv({
    server: config.server,
    client: {},
    clientPrefix: '',
    runtimeEnv,
    skipValidation,
    onValidationError: config.options?.onValidationError,
  });
}
