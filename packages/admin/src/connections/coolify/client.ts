import { z } from 'zod';

import { getLogger } from '@arki/log';

import { isFailure } from '@arki/failure';

import { ADMIN_ERROR_CODES, AdminError } from '../../errors.ts';
import { AdminInvalidOutput, AdminUnauthenticated, AdminUnknownCapability, AdminUnreachable } from '../../failures.ts';
import {
  coolifyApplicationListSchema,
  coolifyApplicationSchema,
  coolifyDeploymentListSchema,
  coolifyDeploymentSchema,
  coolifyEnvironmentListSchema,
  coolifyProjectListSchema,
  coolifyServerListSchema,
  coolifyServerSchema,
} from './schemas.ts';

const logger = getLogger('arki:admin:coolify');

const segment = (uuid: string) => encodeURIComponent(uuid);

/** The Coolify API generation this client was written against (docs at coolify.io/docs/api-reference). */
export const COOLIFY_SUPPORTED_MAJOR = 4;

const DEFAULT_TIMEOUT_MS = 10_000;

/** The options both Coolify factories check at construction. */
export const coolifyOptionsSchema = z.object({
  baseUrl: z.url({ protocol: /^https?$/ }),
  token: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
});

/** Options of {@link createCoolifyClient}. Nothing is read from the environment. */
export type CoolifyClientOptions = {
  /** Instance URL, with or without the `/api/v1` suffix. */
  baseUrl: string;
  /** A read-only API token. Sent as a bearer header, never logged. */
  token: string;
  /** Injected fetch (tests pass a fixture replayer). */
  fetch: typeof fetch;
  /** Per-request timeout. Default 10 000 ms. */
  timeoutMs?: number;
};

export type CoolifyVersionProbe = {
  /** The version string as Coolify reported it, without quotes. */
  version: string;
  /** Null when the string has no `major.minor.patch` part. */
  major: number | null;
  /** True when the major version is the one this client was written for. */
  supported: boolean;
};

const versionPattern = /v?(\d+)\.\d+\.\d+/;

function parseVersion(raw: string): CoolifyVersionProbe {
  const text = raw.trim();
  let version = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'string') version = parsed;
  } catch {
    // plain-text body
  }
  const match = versionPattern.exec(version);
  const major = match?.[1] === undefined ? null : Number(match[1]);
  return { version, major, supported: major === COOLIFY_SUPPORTED_MAJOR };
}

/** What a Coolify call can return instead of its value. The token and the response body are never in a message. */
export type CoolifyFailure =
  | ReturnType<typeof AdminUnreachable>
  | ReturnType<typeof AdminUnauthenticated>
  | ReturnType<typeof AdminUnknownCapability>
  | ReturnType<typeof AdminInvalidOutput>;

/**
 * Read-only Coolify client. Every method is a GET. A call returns its value or a {@link CoolifyFailure}:
 * unreachable (network, timeout, a bad status), unauthenticated (token rejected), unknown capability
 * (404) or invalid output (a body that is not the expected JSON). Only invalid options throw.
 */
export function createCoolifyClient(options: CoolifyClientOptions) {
  const parsed = coolifyOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidConfig,
      'Coolify client options are invalid (baseUrl must be an http(s) URL, token non-empty).',
      'Pass the instance URL and a read-only API token.',
    );
  }
  const root = parsed.data.baseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  const apiBase = `${root}/api/v1`;
  const timeoutMs = parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { token } = parsed.data;
  const doFetch = options.fetch;

  async function getText(path: string): Promise<string | CoolifyFailure> {
    let response: Response;
    try {
      response = await doFetch(`${apiBase}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // The underlying error is dropped on purpose: it may echo request headers.
      logger.debug('coolify GET {path} failed before a response', { path });
      return AdminUnreachable({ detail: `Coolify did not answer GET ${path} (network error or timeout).` });
    }
    logger.debug('coolify GET {path} -> {status}', { path, status: response.status });
    if (response.status === 401 || response.status === 403) {
      return AdminUnauthenticated({
        detail: `Coolify rejected the token for GET ${path} (HTTP ${response.status}). Create a read-only API token and pass it again.`,
      });
    }
    if (response.status === 404) {
      return AdminUnknownCapability({ detail: `Coolify has no resource at GET ${path}.` });
    }
    if (!response.ok) {
      return AdminUnreachable({ detail: `Coolify answered GET ${path} with HTTP ${response.status}.` });
    }
    return response.text();
  }

  async function get<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S> | CoolifyFailure> {
    const text = await getText(path);
    if (isFailure(text)) return text;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return AdminInvalidOutput({ detail: `Coolify returned a non-JSON body for GET ${path}.` });
    }
    const result = schema.safeParse(body);
    if (!result.success) {
      // Paths only: never echo values from the body.
      const paths = result.error.issues.map(issue => issue.path.join('.') || '(root)').join(', ');
      return AdminInvalidOutput({
        detail: `Coolify response for GET ${path} does not match the expected shape (fields: ${paths}).`,
      });
    }
    return result.data;
  }

  return {
    listApplications: () => get('/applications', coolifyApplicationListSchema),
    getApplication: (uuid: string) => get(`/applications/${segment(uuid)}`, coolifyApplicationSchema),
    /** Most recent deployments of one application. */
    listDeployments: (applicationUuid: string, page: { skip?: number; take?: number } = {}) =>
      get(
        `/deployments/applications/${segment(applicationUuid)}?skip=${page.skip ?? 0}&take=${page.take ?? 10}`,
        coolifyDeploymentListSchema,
      ),
    getDeployment: (uuid: string) => get(`/deployments/${segment(uuid)}`, coolifyDeploymentSchema),
    listServers: () => get('/servers', coolifyServerListSchema),
    getServer: (uuid: string) => get(`/servers/${segment(uuid)}`, coolifyServerSchema),
    listProjects: () => get('/projects', coolifyProjectListSchema),
    /** A project's environments. An application's `environment_id` is one of their `id`s. */
    listEnvironments: (projectUuid: string) =>
      get(`/projects/${segment(projectUuid)}/environments`, coolifyEnvironmentListSchema),
    /** Installed-version probe, so Foreman can warn on an unsupported Coolify. */
    probeVersion: async (): Promise<CoolifyVersionProbe | CoolifyFailure> => {
      const text = await getText('/version');
      return isFailure(text) ? text : parseVersion(text);
    },
  };
}

export type CoolifyClient = ReturnType<typeof createCoolifyClient>;
