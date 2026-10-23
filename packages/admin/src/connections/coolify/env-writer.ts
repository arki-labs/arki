import { z } from 'zod';

import { getLogger } from '@arki/log';

import type { CoolifyClientOptions } from './client';
import { ADMIN_ERROR_CODES, AdminError } from '../../errors';
import { coolifyOptionsSchema } from './client';

/**
 * Writes environment variables to Coolify applications, for provisioning keys. It is separate
 * from {@link createCoolifyClient}, so code holding only the reader cannot write. Its token
 * needs the `write` ability.
 *
 * Every variable is stored runtime-only, literal and outside previews. Coolify makes a new
 * variable build-time too unless told otherwise, and a version that does not know the flag
 * drops it silently. So before a real value is sent, the writer stores a harmless probe,
 * checks the flags Coolify kept, and deletes it. It never reads values back, and it never
 * logs or echoes a request or response body.
 */

const logger = getLogger('arki:admin:coolify');

const segment = (uuid: string) => encodeURIComponent(uuid);

const DEFAULT_TIMEOUT_MS = 10_000;

/** The probe variable the writer stores and deletes before each write. */
export const COOLIFY_RUNTIME_PROBE_KEY = 'ARKI_ADMIN_RUNTIME_ONLY_PROBE';

export const coolifyEnvEntrySchema = z.object({
  key: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'Use an UPPER_SNAKE_CASE variable name.'),
  value: z.string().min(1),
  /** Hidden in Coolify's UI and API after it is saved (`is_shown_once`). Use it for private keys. */
  secret: z.boolean(),
});

export type CoolifyEnvEntry = z.input<typeof coolifyEnvEntrySchema>;

/** The flags Coolify stored. A strict object: `value` and `real_value` are dropped while parsing. */
const storedFlagsSchema = z.array(
  z.object({
    uuid: z.string().min(1),
    key: z.string(),
    is_runtime: z.boolean(),
    is_buildtime: z.boolean(),
    is_preview: z.boolean(),
  }),
);

type StoredFlags = z.output<typeof storedFlagsSchema>[number];

const runtimeOnly = (row: StoredFlags | undefined) =>
  row !== undefined && row.is_runtime && !row.is_buildtime && !row.is_preview;

/** Write-capable Coolify client for environment variables. Nothing is read from the environment. */
export function createCoolifyEnvWriter(options: CoolifyClientOptions) {
  const parsed = coolifyOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidConfig,
      'Coolify env writer options are invalid (baseUrl must be an http(s) URL, token non-empty).',
      'Pass the instance URL and an API token with the write ability.',
    );
  }
  const root = parsed.data.baseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  const apiBase = `${root}/api/v1`;
  const timeoutMs = parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { token } = parsed.data;
  const doFetch = options.fetch;

  async function send(method: 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<string> {
    let response: Response;
    try {
      response = await doFetch(`${apiBase}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // The underlying error is dropped on purpose: it may echo request headers or the body.
      logger.debug('coolify {method} {path} failed before a response', { method, path });
      throw new AdminError(
        ADMIN_ERROR_CODES.unreachable,
        `Coolify did not answer ${method} ${path} (network error or timeout).`,
        'Check the Coolify URL and that the instance is up.',
      );
    }
    logger.debug('coolify {method} {path} -> {status}', { method, path, status: response.status });
    if (response.status === 401 || response.status === 403) {
      throw new AdminError(
        ADMIN_ERROR_CODES.unauthenticated,
        `Coolify rejected the token for ${method} ${path} (HTTP ${response.status}).`,
        'Use an API token with the write ability for this team.',
      );
    }
    if (response.status === 404) {
      throw new AdminError(
        ADMIN_ERROR_CODES.unknownCapability,
        `Coolify has no resource at ${method} ${path}.`,
        'Check the application uuid, or that this Coolify version has the endpoint.',
      );
    }
    if (response.status === 400 || response.status === 422) {
      // Coolify's validation errors can quote the submitted values, so only the status is kept.
      throw new AdminError(
        ADMIN_ERROR_CODES.invalidInput,
        `Coolify refused ${method} ${path} (HTTP ${response.status}).`,
        'Check the variable names and that every value is non-empty.',
      );
    }
    if (!response.ok) {
      throw new AdminError(
        ADMIN_ERROR_CODES.unreachable,
        `Coolify answered ${method} ${path} with HTTP ${response.status}.`,
        'Retry later; check the Coolify instance health.',
      );
    }
    return response.text();
  }

  /** Upserts `entries` runtime-only and returns the flags Coolify stored, never the values. */
  async function upsert(applicationUuid: string, entries: readonly z.output<typeof coolifyEnvEntrySchema>[]) {
    const path = `/applications/${segment(applicationUuid)}/envs/bulk`;
    const text = await send('PATCH', path, {
      data: entries.map(entry => ({
        key: entry.key,
        value: entry.value,
        is_runtime: true,
        is_buildtime: false,
        is_preview: false,
        is_literal: true,
        is_multiline: false,
        is_shown_once: entry.secret,
      })),
    });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const flags = storedFlagsSchema.safeParse(body);
    if (!flags.success) {
      throw new AdminError(
        ADMIN_ERROR_CODES.invalidOutput,
        `Coolify's answer to PATCH ${path} does not list the stored flags.`,
        'Check the variables in Coolify by hand: each must have "Build variable" off. The Coolify API may have changed.',
      );
    }
    return flags.data;
  }

  /** Stores a harmless probe, checks Coolify kept it runtime-only, and deletes it. */
  async function probe(applicationUuid: string) {
    const stored = await upsert(applicationUuid, [
      { key: COOLIFY_RUNTIME_PROBE_KEY, value: 'runtime-only', secret: false },
    ]);
    const row = stored.find(entry => entry.key === COOLIFY_RUNTIME_PROBE_KEY);
    if (row !== undefined) {
      await send('DELETE', `/applications/${segment(applicationUuid)}/envs/${segment(row.uuid)}`).catch(() => {
        logger.debug('coolify probe {key} was not deleted from {app}', {
          key: COOLIFY_RUNTIME_PROBE_KEY,
          app: applicationUuid,
        });
      });
    }
    if (!runtimeOnly(row)) {
      throw new AdminError(
        ADMIN_ERROR_CODES.protocolUnsupported,
        'This Coolify did not keep a variable runtime-only (the probe came back build-time, preview or missing). No real value was written.',
        'Upgrade Coolify to a version whose API takes is_buildtime, or set the variables by hand with "Build variable" off.',
      );
    }
  }

  return {
    /**
     * Writes `entries` to one application, runtime-only. Probes first, so a Coolify that would
     * store them build-time gets no real value. Throws when any stored flag comes back wrong.
     * A changed variable takes effect on the application's next deploy.
     */
    async write(applicationUuid: string, entries: readonly CoolifyEnvEntry[]): Promise<{ keys: string[] }> {
      const checked = z.array(coolifyEnvEntrySchema).min(1).safeParse(entries);
      if (!checked.success) {
        const paths = checked.error.issues.map(issue => issue.path.join('.') || '(root)').join(', ');
        throw new AdminError(
          ADMIN_ERROR_CODES.invalidInput,
          `Coolify env entries are invalid (fields: ${paths}).`,
          'Pass at least one entry, each with an UPPER_SNAKE_CASE key and a non-empty value.',
        );
      }
      await probe(applicationUuid);
      const stored = await upsert(applicationUuid, checked.data);
      const wrong = checked.data
        .map(entry => entry.key)
        .filter(key => !runtimeOnly(stored.find(row => row.key === key)));
      if (wrong.length > 0) {
        throw new AdminError(
          ADMIN_ERROR_CODES.invalidOutput,
          `Coolify did not confirm ${wrong.join(', ')} as runtime-only.`,
          'In Coolify, turn "Build variable" off for these keys before the next deploy.',
        );
      }
      return { keys: checked.data.map(entry => entry.key) };
    },
  };
}

export type CoolifyEnvWriter = ReturnType<typeof createCoolifyEnvWriter>;
