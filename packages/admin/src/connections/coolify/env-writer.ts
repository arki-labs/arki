import { z } from 'zod';

import { getLogger } from '@arki/log';

import type { CoolifyClientOptions } from './client.ts';
import { isFailure } from '@arki/failure';

import { ADMIN_ERROR_CODES, AdminError } from '../../errors.ts';
import {
  AdminInvalidOutput,
  AdminInvalidRequest,
  AdminProtocolUnsupported,
  AdminUnauthenticated,
  AdminUnknownCapability,
  AdminUnreachable,
} from '../../failures.ts';
import { coolifyOptionsSchema } from './client.ts';

/**
 * Writes environment variables to Coolify applications, for provisioning keys. It is separate
 * from {@link createCoolifyClient}, so code holding only the reader cannot write. Its token
 * needs the `write` ability.
 *
 * Every variable is stored runtime-only, literal and outside previews. Coolify makes a new
 * variable build-time too unless told otherwise, and a version that does not know the flag
 * drops it silently. So before a real value is sent, the writer stores a harmless probe,
 * checks the flags Coolify kept, and deletes it.
 *
 * Coolify also copies every new variable into the application's preview environment, where
 * `is_shown_once` is not copied. A key written for production must not ride along into PR
 * previews, so after each write the writer deletes the preview copies of the keys it wrote.
 * It reads back names and flags only, never values, and never logs or echoes a body.
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

/** An application's variables as `GET /envs` lists them. A strict object: values are dropped while parsing. */
const listedEnvsSchema = z.array(z.object({ uuid: z.string().min(1), key: z.string(), is_preview: z.boolean() }));

const runtimeOnly = (row: StoredFlags | undefined) =>
  row !== undefined && row.is_runtime && !row.is_buildtime && !row.is_preview;

/** What a Coolify write call can return instead of its value. The token and response bodies are never in a message. */
export type CoolifyEnvFailure =
  | ReturnType<typeof AdminUnreachable>
  | ReturnType<typeof AdminUnauthenticated>
  | ReturnType<typeof AdminUnknownCapability>
  | ReturnType<typeof AdminInvalidRequest>
  | ReturnType<typeof AdminInvalidOutput>
  | ReturnType<typeof AdminProtocolUnsupported>;

/** Parses an answer with a strict schema; on a mismatch, names the request, never the body. */
function answerOf<S extends z.ZodType>(
  text: string,
  schema: S,
  request: string,
): z.output<S> | ReturnType<typeof AdminInvalidOutput> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return AdminInvalidOutput({
      detail: `Coolify's answer to ${request} does not have the expected shape. Check the variables in Coolify by hand: each must have "Build variable" off.`,
    });
  }
  return parsed.data;
}

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

  async function send(
    method: 'GET' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<string | CoolifyEnvFailure> {
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
      return AdminUnreachable({ detail: `Coolify did not answer ${method} ${path} (network error or timeout).` });
    }
    logger.debug('coolify {method} {path} -> {status}', { method, path, status: response.status });
    if (response.status === 401 || response.status === 403) {
      return AdminUnauthenticated({
        detail: `Coolify rejected the token for ${method} ${path} (HTTP ${response.status}). Use an API token with the write ability for this team.`,
      });
    }
    if (response.status === 404) {
      return AdminUnknownCapability({ detail: `Coolify has no resource at ${method} ${path}.` });
    }
    if (response.status === 400 || response.status === 422) {
      // Coolify's validation errors can quote the submitted values, so only the status is kept.
      return AdminInvalidRequest({ detail: `Coolify refused ${method} ${path} (HTTP ${response.status}).` });
    }
    if (!response.ok) {
      return AdminUnreachable({ detail: `Coolify answered ${method} ${path} with HTTP ${response.status}.` });
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
    if (isFailure(text)) return text;
    return answerOf(text, storedFlagsSchema, `PATCH ${path}`);
  }

  /** Deletes the variables `pick` selects. Lists uuids, names and flags only. */
  async function deleteEnvs(
    applicationUuid: string,
    pick: (env: z.output<typeof listedEnvsSchema>[number]) => boolean,
  ): Promise<undefined | CoolifyEnvFailure> {
    const path = `/applications/${segment(applicationUuid)}/envs`;
    const text = await send('GET', path);
    if (isFailure(text)) return text;
    const listed = answerOf(text, listedEnvsSchema, `GET ${path}`);
    if (isFailure(listed)) return listed;
    for (const env of listed.filter(entry => pick(entry))) {
      const deleted = await send('DELETE', `${path}/${segment(env.uuid)}`);
      if (isFailure(deleted)) return deleted;
    }
    return undefined;
  }

  /** Deletes the preview copies of `keys`, which Coolify makes for every new variable. */
  async function removePreviewCopies(applicationUuid: string, keys: readonly string[]) {
    const wanted = new Set(keys);
    return deleteEnvs(applicationUuid, env => env.is_preview && wanted.has(env.key));
  }

  /** Stores a harmless probe, checks Coolify kept it runtime-only, and deletes it. */
  async function probe(applicationUuid: string): Promise<undefined | CoolifyEnvFailure> {
    const stored = await upsert(applicationUuid, [
      { key: COOLIFY_RUNTIME_PROBE_KEY, value: 'runtime-only', secret: false },
    ]);
    if (isFailure(stored)) return stored;
    const row = stored.find(entry => entry.key === COOLIFY_RUNTIME_PROBE_KEY);
    // Both copies: the probe and the preview copy Coolify made of it. A failed cleanup is logged, not returned.
    const cleaned = await deleteEnvs(applicationUuid, env => env.key === COOLIFY_RUNTIME_PROBE_KEY);
    if (isFailure(cleaned)) {
      logger.debug('coolify probe {key} was not deleted from {app}', {
        key: COOLIFY_RUNTIME_PROBE_KEY,
        app: applicationUuid,
      });
    }
    if (!runtimeOnly(row)) {
      return AdminProtocolUnsupported({
        detail:
          'This Coolify did not keep a variable runtime-only (the probe came back build-time, preview or missing). No real value was written. Upgrade Coolify to a version whose API takes is_buildtime, or set the variables by hand with "Build variable" off.',
      });
    }
    return undefined;
  }

  return {
    /**
     * Writes `entries` to one application, runtime-only. Probes first, so a Coolify that would
     * store them build-time gets no real value. Returns a {@link CoolifyEnvFailure} when Coolify
     * cannot be reached or refuses, or when any stored flag comes back wrong.
     * Then deletes the preview copies Coolify made of them. A changed variable takes effect
     * on the application's next deploy.
     */
    async write(
      applicationUuid: string,
      entries: readonly CoolifyEnvEntry[],
    ): Promise<{ keys: string[] } | CoolifyEnvFailure> {
      const checked = z.array(coolifyEnvEntrySchema).min(1).safeParse(entries);
      if (!checked.success) {
        const paths = checked.error.issues.map(issue => issue.path.join('.') || '(root)').join(', ');
        return AdminInvalidRequest({
          detail: `Coolify env entries are invalid (fields: ${paths}). Pass at least one entry, each with an UPPER_SNAKE_CASE key and a non-empty value.`,
        });
      }
      const probed = await probe(applicationUuid);
      if (probed !== undefined) return probed;
      const stored = await upsert(applicationUuid, checked.data);
      if (isFailure(stored)) return stored;
      const wrong = checked.data
        .map(entry => entry.key)
        .filter(key => !runtimeOnly(stored.find(row => row.key === key)));
      if (wrong.length > 0) {
        return AdminInvalidOutput({
          detail: `Coolify did not confirm ${wrong.join(', ')} as runtime-only. In Coolify, turn "Build variable" off for these keys before the next deploy.`,
        });
      }
      const keys = checked.data.map(entry => entry.key);
      const removed = await removePreviewCopies(applicationUuid, keys);
      if (removed !== undefined) return removed;
      return { keys };
    },

    /**
     * Deletes the preview copies of `keys` on one application, leaving the production variables.
     * For variables written before the writer removed them itself. Returns a {@link CoolifyEnvFailure}
     * when Coolify cannot be reached or refuses.
     */
    removePreviewCopies,
  };
}

export type CoolifyEnvWriter = ReturnType<typeof createCoolifyEnvWriter>;
