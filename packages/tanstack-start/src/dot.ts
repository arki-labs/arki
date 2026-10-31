/**
 * `@arki/tanstack-start/dot` — the `tanstackStart()` entrypoint plugin and
 * the one-line server-route handlers.
 *
 * `tanstackStart()` provides one service, `tanstackStart`, that builds the
 * plugin's part of each request's context from its typed `needs`, and the
 * declared mounts. `startServer(app)` adds `services` and hands the whole
 * context to Start.
 *
 * ```ts
 * // A driver such as `schedule()` has no `provides` handles: name its service by key.
 * const scheduler = token<SchedulerProvides['scheduler']>()('scheduler');
 *
 * export const app = defineApp('shop')
 *   .infra(database, authn)
 *   .features([...features, gateway])
 *   .entrypoints(
 *     schedule({ clock: 'host' }),
 *     tanstackStart({
 *       needs: { rpc: gateway.provides.rpc, auth: authn.provides.auth, scheduler },
 *       session: ({ auth }, request) => auth.principal(request.headers),
 *       rpc: ({ rpc }, request) => rpc.client(request.headers),
 *       mounts: {
 *         rpc: { at: '/api/rpc', serve: ({ rpc }, request, prefix) => rpc.handle(request, prefix) },
 *         auth: { at: '/api/auth', serve: ({ auth }, request) => auth.handler(request) },
 *         cron: { at: '/api/cron', router: cronRouter, secret: () => env.CRON_SECRET, schedules: ({ scheduler }) => scheduler },
 *         health: { at: '/api/health' },
 *       },
 *       cors: () => ({ origins: [env.VITE_URL], extensions: true }),
 *     }),
 *   );
 * ```
 *
 * The needs are checked against the builder: placing `tanstackStart()`
 * before the plugins that provide them is a compile error. The cron secret
 * and the CORS options are functions, read when the app boots and never at
 * import, so `vite build` runs without the server's env.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { z } from 'zod';

import type { CtxOf, NeedsShape, NoReservedKeys } from '@arki/dot';
import type { ActionDeclaration } from '@arki/dot/unit';
import type { SchemaFailure } from '@arki/failure';
import type { CronContext } from '@arki/schedule/orpc';
import { entrypoint } from '@arki/dot';
import { DotUnitError } from '@arki/dot/unit';
import { InvalidInput, isFailure } from '@arki/failure';
import { cronErrorBody } from '@arki/schedule/orpc';
import { formatIssues, parse } from '@arki/schema';

import type {
  CorsOptions,
  CorsPolicy,
  MountHandles,
  MountName,
  MountPrefix,
  RpcServed,
  StartService,
} from './request-context.js';
import { corsSchema } from './cors.js';

export { authHandlers, cronHandlers, healthHandlers, rpcHandlers } from './mounts.js';
export type { RequestContextOf } from './request-context.js';
export type { CorsOptions } from './request-context.js';

const atSchema = z
  .string()
  .regex(/^\/.*[^/]$/, 'A mount path starts with "/" and has no trailing slash, like "/api/rpc".');

/** Every declared `at`, in declaration order: each well formed, no two the same. */
const mountPathsSchema = z
  .array(atSchema)
  .refine(paths => new Set(paths).size === paths.length, 'Two mounts share one path: give each mount its own `at`.');

const cronSecretSchema = z.string().min(1, 'The cron secret must not be empty.');

/**
 * Stable error codes thrown when `tanstackStart()` boots. Match on the code,
 * never on the message.
 */
export const TANSTACK_START_PLUGIN_ERROR_CODES = {
  /**
   * The cron mount's `secret()` returned an empty or missing value at boot.
   *
   * @fix Set the env var `secret` reads (such as `CRON_SECRET`) on the server, not at build time.
   * @verify bun run test -- src/dot.test.ts
   */
  cronSecretInvalid: 'ARKI_TANSTACK_START_PLUGIN_E001',
  /**
   * `cors()` returned an origin that is not a bare `scheme://host[:port]`.
   *
   * @fix Remove any path or trailing slash from each origin, such as `https://shop.example`.
   * @verify bun run test -- src/dot.test.ts
   */
  corsInvalid: 'ARKI_TANSTACK_START_PLUGIN_E002',
} as const;

/** The coded error that stops the boot when a value read at boot fails its schema. */
function bootError(
  failure: SchemaFailure,
  error: { readonly code: string; readonly what: string; readonly remediation: string },
): DotUnitError {
  const reason = InvalidInput.is(failure) ? formatIssues(failure.data.issues) : failure.message;
  return new DotUnitError({
    code: error.code,
    message: `[tanstack-start] ${error.what}: ${reason}`,
    remediation: error.remediation,
    docsUrl: `https://arki.dev/dot/errors/${error.code.toLowerCase().replaceAll('_', '-')}`,
  });
}

/** A router whose procedures run on the cron context — the app's `cronRouter`. */
export type CronRouter = ConstructorParameters<typeof OpenAPIHandler<CronContext>>[0];

/**
 * The `mounts` option: each mount is optional, says where it lives (`at`)
 * and how it serves, as a function of the plugin's own needs.
 *
 * @example
 * const mounts = {
 *   rpc: { at: '/api/rpc', serve: ({ rpc }, request, prefix) => rpc.handle(request, prefix) },
 *   health: { at: '/api/health' },
 * } satisfies MountOptions<{ rpc: Gateway }>;
 */
export type MountOptions<Needs> = {
  /** The rpc mount. `serve` answers like oRPC's `RPCHandler.handle`; unmatched is a 404. */
  readonly rpc?: {
    readonly at: MountPrefix;
    readonly serve: (needs: Needs, request: Request, prefix: MountPrefix) => RpcServed | Promise<RpcServed>;
  };
  /** The auth mount, such as Better Auth's `auth.handler(request)`. */
  readonly auth?: {
    readonly at: MountPrefix;
    readonly serve: (needs: Needs, request: Request) => Response | Promise<Response>;
  };
  /**
   * The cron mount: the app's cron router, the bearer secret the host sends
   * (read at boot, such as `() => env.CRON_SECRET`), the scheduler that runs it.
   */
  readonly cron?: {
    readonly at: MountPrefix;
    readonly router: CronRouter;
    readonly secret: () => string;
    readonly schedules: (needs: Needs) => CronContext['schedules'];
  };
  /** The health probe: `GET` answers `{ status: 'ok' }` once the app has started. */
  readonly health?: { readonly at: MountPrefix };
};

/**
 * Options of {@link tanstackStart}. `session`, `rpc` and every mount
 * receive the resolved `needs`; what `rpc` and `session` return types
 * `context.rpc` and `context.session()`.
 *
 * @example
 * const options = {
 *   needs: { auth: authn.provides.auth },
 *   session: ({ auth }, request) => auth.principal(request.headers),
 *   rpc: ({ auth }, request) => clientFor(auth, request.headers),
 * } satisfies TanstackStartOptions<{ auth: typeof authn.provides.auth }, Client, Promise<Principal | null>, never>;
 */
export type TanstackStartOptions<Needs extends NeedsShape, RpcResult, SessionResult, Declared extends MountName> = {
  /** The services this entrypoint reads, as provider handles. */
  readonly needs: Needs;
  /** The caller's session. Called at most once per request, and only when read. */
  readonly session: (needs: CtxOf<Needs>, request: Request) => SessionResult;
  /** The in-process RPC client for one request. Built before Start runs the request. */
  readonly rpc: (needs: CtxOf<Needs>, request: Request) => RpcResult;
  /** The server routes this entrypoint serves. Only declared mounts reach the manifest. */
  readonly mounts?: { readonly [Name in Declared]: NonNullable<MountOptions<CtxOf<Needs>>[Name]> };
  /** Which cross-origin callers the rpc mount answers, read at boot. No option: same origin only. */
  readonly cors?: () => CorsOptions;
};

const MOUNT_SUMMARIES: Readonly<Record<MountName, string>> = {
  rpc: 'RPC procedures over HTTP (rpcHandlers).',
  auth: 'Auth endpoints (authHandlers).',
  cron: 'Host-triggered schedules, bearer-secret protected (cronHandlers).',
  health: 'Liveness probe (healthHandlers).',
};

/** The declared mounts, in a fixed order, with their paths. */
function declared<Needs>(mounts: MountOptions<Needs> | undefined) {
  const entries: { readonly name: MountName; readonly at: MountPrefix }[] = [];
  if (mounts?.rpc !== undefined) entries.push({ name: 'rpc', at: mounts.rpc.at });
  if (mounts?.auth !== undefined) entries.push({ name: 'auth', at: mounts.auth.at });
  if (mounts?.cron !== undefined) entries.push({ name: 'cron', at: mounts.cron.at });
  if (mounts?.health !== undefined) entries.push({ name: 'health', at: mounts.health.at });
  return entries;
}

function mountActions<Needs>(mounts: MountOptions<Needs> | undefined): readonly ActionDeclaration[] {
  return declared(mounts).map(({ name, at }) => ({
    id: `tanstack-start.${name}`,
    binding: 'http',
    direction: 'in',
    address: name === 'health' ? at : `${at}/*`,
    summary: MOUNT_SUMMARIES[name],
  }));
}

/** Only `chrome-extension://` origins count as extensions, as Chromium sends them. */
const EXTENSION_ORIGIN = 'chrome-extension://';

function corsPolicy(read: (() => CorsOptions) | undefined): CorsPolicy {
  const options = parse(corsSchema, read?.() ?? { origins: [] });
  if (isFailure(options)) {
    throw bootError(options, {
      code: TANSTACK_START_PLUGIN_ERROR_CODES.corsInvalid,
      what: 'the CORS options are invalid',
      remediation: 'List each origin as scheme://host[:port], with no path and no trailing slash.',
    });
  }
  const origins = new Set(options.origins);
  const extensions = options.extensions ?? false;
  return {
    allows: (origin): origin is string =>
      origin !== null && (origins.has(origin) || (extensions && origin.startsWith(EXTENSION_ORIGIN))),
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time on any length: compare digests, never the raw strings. */
function sameSecret(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

/** The 401 bodies cron hosts and on-call already rely on. */
function cronAuthError(request: Request, secret: string): Response | undefined {
  const header = request.headers.get('Authorization');
  if (header === null) return Response.json({ error: 'Missing Authorization header' }, { status: 401 });
  if (!header.startsWith('Bearer ')) {
    return Response.json({ error: 'Authorization header must use Bearer scheme' }, { status: 401 });
  }
  if (!sameSecret(header.slice('Bearer '.length), secret)) {
    return Response.json({ error: 'Invalid cron secret' }, { status: 401 });
  }
  return undefined;
}

function cronMount<Needs>(cron: NonNullable<MountOptions<Needs>['cron']>, needs: Needs): MountHandles['cron'] {
  const secret = parse(cronSecretSchema, cron.secret());
  if (isFailure(secret)) {
    throw bootError(secret, {
      code: TANSTACK_START_PLUGIN_ERROR_CODES.cronSecretInvalid,
      what: 'the cron secret is missing',
      remediation: 'Set the env var the cron secret() reads (such as CRON_SECRET) on the server before booting.',
    });
  }
  // Built once per app: the router is static data.
  const handler = new OpenAPIHandler(cron.router, { customErrorResponseBodyEncoder: cronErrorBody });
  return {
    at: cron.at,
    async serve(request) {
      const denied = cronAuthError(request, secret);
      if (denied !== undefined) return denied;
      const carry: CronContext['carry'] = {};
      // No cron takes input: a stray body is never parsed.
      const bodyless = new Request(request.url, { method: request.method, headers: request.headers });
      const { matched, response } = await handler.handle(bodyless, {
        prefix: cron.at,
        context: { headers: request.headers, schedules: cron.schedules(needs), carry },
      });
      // A failed run leaves oRPC through `carry` and is rethrown, so the host's error reporting sees it.
      if (carry.rethrow) throw carry.rethrow.cause;
      return matched ? response : new Response('Not found', { status: 404 });
    },
  };
}

/** Bind each declared mount to its `at` and to the plugin's needs. */
function mountHandles<Needs>(mounts: MountOptions<Needs> | undefined, needs: Needs): Partial<MountHandles> {
  const { rpc, auth, cron, health } = mounts ?? {};
  return {
    ...(rpc === undefined ? {} : { rpc: { at: rpc.at, serve: async request => rpc.serve(needs, request, rpc.at) } }),
    ...(auth === undefined ? {} : { auth: { at: auth.at, serve: async request => auth.serve(needs, request) } }),
    ...(cron === undefined ? {} : { cron: cronMount(cron, needs) }),
    ...(health === undefined ? {} : { health: { at: health.at } }),
  };
}

/**
 * The TanStack Start entrypoint of a Dot app. Provides `tanstackStart`: the
 * per-request context builder, the CORS policy and the declared mounts.
 * Declares one manifest action per declared mount, at its `at`, so
 * `dot explain` lists them. `configure` rejects a bad or repeated mount
 * path (no I/O). Booting reads the cron secret and the CORS options, and
 * throws a coded `DotUnitError` when either is bad.
 *
 * @example
 * defineApp('shop')
 *   .features([gateway])
 *   .entrypoints(
 *     tanstackStart({
 *       needs: { rpc: gateway.provides.rpc },
 *       session: () => null,
 *       rpc: ({ rpc }, request) => rpc.client(request.headers),
 *       mounts: { rpc: { at: '/api/rpc', serve: ({ rpc }, request, prefix) => rpc.handle(request, prefix) } },
 *     }),
 *   );
 */
export function tanstackStart<
  const Needs extends NeedsShape & NoReservedKeys,
  RpcResult,
  SessionResult,
  Declared extends MountName = never,
>(options: TanstackStartOptions<Needs, RpcResult, SessionResult, Declared>) {
  const mounts: MountOptions<CtxOf<Needs>> | undefined = options.mounts;
  return entrypoint({
    name: 'tanstack-start',
    needs: options.needs,
    actions: mountActions(mounts),
    configure() {
      const paths = parse(
        mountPathsSchema,
        declared(mounts).map(mount => mount.at),
      );
      return isFailure(paths) ? paths : undefined;
    },
    provides: {
      tanstackStart: (needs): StartService<Awaited<RpcResult>, Awaited<SessionResult>, Declared> => ({
        async context(request, signal) {
          // The memo lives on this request's context only: never shared across requests.
          let session: Promise<Awaited<SessionResult>> | undefined;
          return {
            rpc: await options.rpc(needs, request),
            session: () => (session ??= Promise.resolve(options.session(needs, request))),
            requestId: crypto.randomUUID(),
            signal,
          };
        },
        cors: corsPolicy(options.cors),
        mounts: mountHandles(mounts, needs),
      }),
    },
  });
}
