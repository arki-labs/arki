/**
 * Values that point at a secret manager instead of holding a secret: `op://vault/item/field`,
 * `infisical://<env>/<path>/<NAME>`, `doppler://<project>/<config>/<NAME>`. Each resolves once, at
 * load, through the provider's own CLI, so its login and access rules apply. Only registered schemes
 * are references; `postgres://` and `https://` values stay plain.
 */
import { execFileSync } from 'node:child_process';

import { z } from 'zod';

/** Turns one reference (the whole `scheme://...` string) into its secret. Throws on failure. */
export type ReferenceResolver = (reference: string) => string;

/** The resolvers `loadEnvFiles` uses unless it is given its own. */
export const DEFAULT_RESOLVERS: Readonly<Record<string, ReferenceResolver>> = {
  op: reference => runProvider('op', ['read', '--no-newline', reference]),
  infisical: reference => {
    const [environment, ...rest] = pathOf(reference);
    const name = rest.pop();
    if (environment === undefined || name === undefined) throw new Error('expected infisical://<env>/<path>/<NAME>');
    return runProvider('infisical', ['secrets', 'get', '--plain', '--silent', `--env=${environment}`, `--path=/${rest.join('/')}`, '--', name]);
  },
  doppler: reference => {
    const [project, config, name, ...extra] = pathOf(reference);
    if (project === undefined || config === undefined || name === undefined || extra.length > 0) {
      throw new Error('expected doppler://<project>/<config>/<NAME>');
    }
    return runProvider('doppler', ['secrets', 'get', '--plain', `--project=${project}`, `--config=${config}`, '--', name]);
  },
};

/** The scheme of `value` when it is a reference to one of `resolvers`, else `undefined`. */
export function referenceScheme(value: string, resolvers: Readonly<Record<string, ReferenceResolver>>): string | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/./.exec(value)?.[1];
  return scheme !== undefined && Object.hasOwn(resolvers, scheme) ? scheme : undefined;
}

const execError = z.object({ code: z.string().optional(), stderr: z.string().optional() });

function runProvider(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).replace(/\r?\n$/, '');
  } catch (error) {
    const parsed = execError.safeParse(error);
    const detail = parsed.success ? parsed.data : {};
    if (detail.code === 'ENOENT') throw new Error(`the \`${command}\` CLI is not installed or not on PATH`, { cause: error });
    const firstLine = detail.stderr?.trim().split('\n')[0];
    throw new Error(firstLine === undefined || firstLine === '' ? `\`${command}\` failed` : `\`${command}\`: ${firstLine}`, { cause: error });
  }
}

/** Path segments may never start with `-` (they would read as flags) or hold shell-ish characters. */
const SEGMENT = /^\w[\w.-]*$/;

function pathOf(reference: string): string[] {
  const parts = reference
    .slice(reference.indexOf('://') + 3)
    .split('/')
    .filter(part => part !== '');
  const bad = parts.find(part => !SEGMENT.test(part));
  if (bad !== undefined) throw new Error(`reference segment "${bad}" must match ${String(SEGMENT)}`);
  return parts;
}
