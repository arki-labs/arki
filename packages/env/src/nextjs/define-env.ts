import { createEnv } from '@t3-oss/env-nextjs';
import type { ZodType } from 'zod';

type EnvConfig = {
  server?: Record<string, ZodType>;
  client?: Record<string, ZodType>;
  shared?: Record<string, ZodType>;
  experimental__runtimeEnv: Record<string, string | undefined>;
  options?: {
    skipValidation?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onValidationError?: (issues: any) => never;
  };
};

export function defineEnv(config: EnvConfig) {
  const skipValidation = config.options?.skipValidation ?? (!!process.env.CI || process.env.npm_lifecycle_event === 'lint');

  return createEnv({
    server: config.server,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: config.client as any,
    shared: config.shared,
    experimental__runtimeEnv: config.experimental__runtimeEnv,
    skipValidation,
    onValidationError: config.options?.onValidationError,
  });
}
