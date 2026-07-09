import { createEnv } from '@t3-oss/env-core';
import type { CreateEnv, DefaultCombinedSchema } from '@t3-oss/env-core';
import { lazyObject } from '@arki/ts';
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
 * Thin, type-preserving wrapper over `@t3-oss/env-core`'s `createEnv`. Generic over the server,
 * client, shared and composed schemas so the parsed env keeps its exact inferred types — the wrapper
 * adds the ARKI defaults (auto `runtimeEnv`, prod-safe `skipValidation`, a legible labelled error
 * handler) without widening any value to `unknown`.
 *
 * `TPrefix` is kept as a string-literal generic on purpose: `createEnv` uses it to enforce that
 * client keys (and only client keys) carry the prefix. Widening it to `string` would make every
 * server key collapse to a type-level `ErrorMessage`, so the prefix must stay a literal.
 */
export function defineEnv<
  TServer extends Record<string, ZodType>,
  TClient extends Record<string, ZodType> = NonNullable<unknown>,
  TShared extends Record<string, ZodType> = NonNullable<unknown>,
  const TPrefix extends string = '',
  const TExtends extends Array<Record<string, unknown>> = [],
>(config: {
  /**
   * Label shown in validation-error logs, e.g. `'@acme/backend'`. Without it a misconfigured
   * deploy logs a bare "Invalid environment variables" with no hint which env failed — exactly the
   * blind failure this wrapper exists to prevent.
   */
  name?: string;
  server: TServer;
  /** Client-side schema. Every key must start with `clientPrefix` (enforced by `createEnv`). */
  client?: TClient;
  /** Prefix client keys must carry, e.g. `'VITE_'`. Defaults to `''` (no client vars). */
  clientPrefix?: TPrefix;
  /** Shared vars available to both client and server, unprefixed (e.g. `NODE_ENV`). */
  shared?: TShared;
  /**
   * Already-built envs to compose in (e.g. `@arki/auth`, `@arki/db`). Their parsed variables merge
   * into the result with full types; each was validated by its own `createEnv` at import time.
   */
  extends?: TExtends;
  /**
   * Explicit runtime source. Omit it and `defineEnv` auto-builds one by reading `process.env` for
   * every declared key — correct for any server-side env. Provide it only when the auto-build would
   * be wrong: Vite/`start` apps whose client vars come from `import.meta.env` in the browser, or
   * keys with a fallback/alias (e.g. `DB_URL: process.env.DB_URL ?? process.env.DATABASE_URL`).
   */
  runtimeEnv?: Record<string, string | boolean | number | undefined>;
  options?: {
    skipValidation?: boolean;
    /**
     * Treat empty-string env values as `undefined` so defaults apply (e.g. `PORT=` in `.env`, or a
     * Docker arg baked as `X=""`). Defaults to `true` — set `false` only if an app intentionally
     * accepts `""` as a valid required string.
     */
    emptyStringAsUndefined?: boolean;
    onValidationError?: (issues: ValidationIssues) => never;
  };
}): CreateEnv<DefaultCombinedSchema<TServer, TClient, TShared>, TExtends> {
  type Result = CreateEnv<DefaultCombinedSchema<TServer, TClient, TShared>, TExtends>;

  // LAZY by design: reading `process.env` and running validation are deferred
  // to the FIRST property access, not the module import. Declaring an env is
  // therefore observationally free — an app's declaration graph (features,
  // adapters, `dot explain`, docs tooling) imports from a bare checkout with
  // zero environment, and validation fires exactly when a value is actually
  // consumed (boot, a request, a job). This is the same import/observe split
  // drizzle tables have: define everywhere, observe only at use.
  const build = (): Result => {
    const skipValidation =
      config.options?.skipValidation ?? (!!process.env.CI || process.env.NODE_ENV !== 'development');

    // Use the caller's explicit runtimeEnv when supplied (Vite client vars via import.meta.env, or
    // fallback aliases). Otherwise auto-build from every declared key (server + client + shared);
    // createEnv tolerates keys absent from process.env (they parse as undefined → optional/default).
    let runtimeEnv: Record<string, string | boolean | number | undefined>;
    if (config.runtimeEnv) {
      runtimeEnv = config.runtimeEnv;
    } else {
      runtimeEnv = {};
      for (const key of Object.keys(config.server)) {
        runtimeEnv[key] = process.env[key];
      }
      for (const key of Object.keys(config.client ?? {})) {
        runtimeEnv[key] = process.env[key];
      }
      for (const key of Object.keys(config.shared ?? {})) {
        runtimeEnv[key] = process.env[key];
      }
    }

    const onValidationError =
      config.options?.onValidationError ??
      ((issues: ValidationIssues): never => {
        const message = formatIssues(config.name, issues);
        console.error(message);
        throw new Error(message);
      });

    // `createEnv`'s `server`/`client` params are conditional on `clientPrefix` being a *concrete*
    // string literal; inside a generic wrapper `TPrefix` is abstract, so the body cannot be verified
    // for all prefixes and the call argument must be asserted once. The PUBLIC contract stays exact:
    // the explicit return type above reconstructs `createEnv`'s own result from the generics, and the
    // caller's `server`/`client`/`extends` are fully type-checked against `TServer`/`TClient`/`TExtends`
    // at the call site. This is the only seam where types are asserted — value types are never widened.
    const options = {
      shared: config.shared ?? {},
      extends: config.extends,
      server: config.server,
      client: config.client ?? {},
      clientPrefix: config.clientPrefix ?? '',
      runtimeEnv,
      skipValidation,
      // Default ON: in containerized deploys an unset var is baked as "" (e.g. Docker `ENV X=${X}`
      // with no build arg), not left absent. Treating "" as undefined lets `.default()`/`.optional()`
      // apply as intended instead of failing format checks like `z.url()` on an empty string.
      emptyStringAsUndefined: config.options?.emptyStringAsUndefined ?? true,
      onValidationError,
    } satisfies Record<string, unknown>;

    return createEnv(options as Parameters<typeof createEnv>[0]) as Result;
  };

  return lazyObject(build);
}
