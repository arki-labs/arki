/** Secret-manager reads use argv, a bounded subprocess and caller-owned provider authentication. */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { ensure, parse } from '@arki/schema';

import { EnvCancelled, EnvDeadline, ReferenceFailed } from './errors.js';
import { nodeOperation } from './operation-telemetry.js';

/** The remaining aggregate budget and cooperative cancellation for a synchronous provider read. */
export type ReferenceOptions = { readonly timeoutMs?: number; readonly signal?: AbortSignal };
/** A provider returns its value or the exact owned provider/cancellation/deadline outcomes. */
export type ReferenceResolver = (reference: string, options?: ReferenceOptions) => ReturnType<typeof runProvider>;

const segment = z.string().regex(/^\w[\w.-]*$/);
const referencePath = z.array(segment);
const timeoutSchema = z.number().int().min(1).max(30_000);
const execFailure = z.object({ code: z.string().optional() });

/** The resolvers used unless the caller supplies an explicit registry. */
export const DEFAULT_RESOLVERS: Readonly<Record<string, ReferenceResolver>> = {
  op: (reference, options) => runProvider('op', ['read', '--no-newline', reference], options),
  infisical: (reference, options) => {
    const parts = pathOf(reference);
    if (isFailure(parts)) return ReferenceFailed({ scheme: 'infisical' }, { cause: parts });
    const [environment, ...rest] = parts;
    const name = rest.pop();
    if (environment === undefined || name === undefined) return ReferenceFailed({ scheme: 'infisical' });
    return runProvider(
      'infisical',
      ['secrets', 'get', '--plain', '--silent', `--env=${environment}`, `--path=/${rest.join('/')}`, '--', name],
      options,
    );
  },
  doppler: (reference, options) => {
    const parts = pathOf(reference);
    if (isFailure(parts)) return ReferenceFailed({ scheme: 'doppler' }, { cause: parts });
    const [project, config, name, ...extra] = parts;
    if (project === undefined || config === undefined || name === undefined || extra.length > 0)
      return ReferenceFailed({ scheme: 'doppler' });
    return runProvider(
      'doppler',
      ['secrets', 'get', '--plain', `--project=${project}`, `--config=${config}`, '--', name],
      options,
    );
  },
};

/** Registered schemes are references; unknown URLs remain plain values. */
export function referenceScheme(
  value: string,
  resolvers: Readonly<Record<string, ReferenceResolver>>,
): string | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/./.exec(value)?.[1];
  return scheme !== undefined && Object.hasOwn(resolvers, scheme) ? scheme : undefined;
}

function runProvider(command: string, args: readonly string[], options: ReferenceOptions = {}) {
  const timeout = ensure(options.timeoutMs ?? 30_000, timeoutSchema);
  return nodeOperation(`reference.${command}`, () => {
    if (options.signal?.aborted) return EnvCancelled({ cause: options.signal.reason });
    try {
      const value = execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        // These are bounded reads: a provider must not evade the deadline by ignoring SIGTERM.
        killSignal: 'SIGKILL',
      }).replace(/\r?\n$/, '');
      return options.signal?.aborted ? EnvCancelled({ cause: options.signal.reason }) : value;
    } catch (error) {
      const detail = execFailure.safeParse(error);
      if (options.signal?.aborted) return EnvCancelled({ cause: error });
      if (detail.success && detail.data.code === 'ETIMEDOUT') return EnvDeadline({ cause: error });
      // CLI stderr may contain a credential. Keep the complete original error only in the private cause.
      return ReferenceFailed({ scheme: command }, { cause: error });
    }
  });
}

function pathOf(reference: string) {
  return parse(
    referencePath,
    reference
      .slice(reference.indexOf('://') + 3)
      .split('/')
      .filter(part => part !== ''),
  );
}
