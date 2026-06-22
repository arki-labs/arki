import { createEnv } from '@t3-oss/env-core';
import type { ZodType } from 'zod';

/** The issue shape t3-oss hands to `onValidationError`, derived so it stays in sync with the lib. */
type ValidationIssues = Parameters<
  NonNullable<Parameters<typeof createEnv>[0]['onValidationError']>
>[0];

/**
 * Fold validation issues into a human-legible, log-pipeline-safe string. The t3-oss default handler
 * logs `issues` as a raw object, which platforms like Coolify collapse to `[Object]` — so the var
 * that actually failed never reaches the logs. A flat `  path: message` list survives transport.
 */
function formatIssues(name: string | undefined, issues: ValidationIssues): string {
  const label = name ? `[${name}] ` : '';
  const lines = issues.map(issue => {
    const path = (issue.path ?? [])
      .map(seg => (typeof seg === 'object' && seg !== null && 'key' in seg ? String(seg.key) : String(seg)))
      .join('.');
    return `  ${path || '(root)'}: ${issue.message}`;
  });
  return `❌ ${label}Invalid environment variables:\n${lines.join('\n')}`;
}

/**
 * Thin, type-preserving wrapper over `@t3-oss/env-core`'s `createEnv`. Generic over the schema and
 * composed envs so the parsed env keeps its exact inferred types — the wrapper adds the ARKI
 * defaults (auto `runtimeEnv`, prod-safe `skipValidation`, a legible labelled error handler) without
 * widening any value to `unknown`.
 */
export function defineEnv<
  TServer extends Record<string, ZodType>,
  const TExtends extends Array<Record<string, unknown>> = [],
>(config: {
  /**
   * Label shown in validation-error logs, e.g. `'@everseek/backend'`. Without it a misconfigured
   * deploy logs a bare "Invalid environment variables" with no hint which env failed — exactly the
   * blind failure this wrapper exists to prevent.
   */
  name?: string;
  server: TServer;
  /**
   * Already-built envs to compose in (e.g. `@arki/auth`, `@arki/db`). Their parsed variables merge
   * into the result with full types; each was validated by its own `createEnv` at import time.
   */
  extends?: TExtends;
  options?: {
    skipValidation?: boolean;
    onValidationError?: (issues: ValidationIssues) => never;
  };
}) {
  const skipValidation =
    config.options?.skipValidation ?? (!!process.env.CI || process.env.NODE_ENV !== 'development');

  // Auto-generate runtimeEnv (no Next.js bundler constraints)
  const runtimeEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(config.server)) {
    runtimeEnv[key] = process.env[key];
  }

  const onValidationError =
    config.options?.onValidationError ??
    ((issues: ValidationIssues): never => {
      const message = formatIssues(config.name, issues);
      console.error(message);
      throw new Error(message);
    });

  return createEnv({
    extends: config.extends,
    server: config.server,
    client: {},
    clientPrefix: '',
    runtimeEnv,
    skipValidation,
    onValidationError,
  });
}
