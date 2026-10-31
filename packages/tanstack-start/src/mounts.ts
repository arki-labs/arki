/**
 * One-line server-route handlers for a Dot app on TanStack Start.
 *
 * Each builder returns a record for `createFileRoute(path)({ server: { handlers } })`.
 * They read only the plugin's own service, `context.services.tanstackStart`:
 * where each mount lives (`at`) and how it serves come from
 * `tanstackStart({ mounts })`. A route using a handler for a mount the app
 * did not declare fails to compile; on erased paths it answers 404 and logs
 * the missing mount.
 *
 * ```ts
 * export const Route = createFileRoute('/api/rpc/$')({ server: { handlers: rpcHandlers() } });
 * ```
 */
import { getLogger } from '@arki/log';

import type { MountedService, MountName } from './request-context.js';

const log = getLogger('arki:tanstack-start');

/** What a server-route handler receives that the `Name` mount reads. */
type MountArgs<Name extends MountName> = {
  readonly request: Request;
  readonly context: { readonly services: { readonly tanstackStart: MountedService<Name> } };
};

const ALLOW_METHODS = 'OPTIONS, GET, POST, PUT, PATCH, DELETE';
const ALLOW_HEADERS = 'Content-Type, Authorization';

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

function undeclared(mount: MountName): Response {
  log.error('A server route uses a mount that tanstackStart() does not declare; add it to the mounts option', {
    mount,
  });
  return notFound();
}

/** Reflect a listed origin (never `*`), so credentialed and bearer calls both work. */
function withCors(response: Response, request: Request, start: MountedService<'rpc'>): Response {
  const origin = request.headers.get('origin');
  response.headers.append('Vary', 'Origin');
  if (!start.cors.allows(origin)) return response;
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', ALLOW_METHODS);
  response.headers.set('Access-Control-Allow-Headers', ALLOW_HEADERS);
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  return response;
}

async function serveRpc({ request, context }: MountArgs<'rpc'>): Promise<Response> {
  const start = context.services.tanstackStart;
  const mount = start.mounts.rpc;
  if (mount === undefined) return undeclared('rpc');
  let response: Response;
  try {
    const served = await mount.serve(request);
    response = served.response ?? notFound();
  } catch (error) {
    log.error('Unhandled RPC error', { error: error instanceof Error ? error : String(error) });
    response = new Response('Internal Server Error', { status: 500 });
  }
  return withCors(response, request, start);
}

function preflight({ request, context }: MountArgs<'rpc'>): Response {
  return withCors(new Response(null, { status: 204 }), request, context.services.tanstackStart);
}

/**
 * Handlers for the rpc mount: serve `mounts.rpc` at its `at`, apply the
 * CORS policy from `tanstackStart({ cors })`, answer preflights with 204 and
 * unmatched paths with 404.
 *
 * @example
 * export const Route = createFileRoute('/api/rpc/$')({ server: { handlers: rpcHandlers() } });
 */
export function rpcHandlers() {
  return { GET: serveRpc, POST: serveRpc, PUT: serveRpc, PATCH: serveRpc, DELETE: serveRpc, OPTIONS: preflight };
}

function serveCron({ request, context }: MountArgs<'cron'>): Promise<Response> {
  const mount = context.services.tanstackStart.mounts.cron;
  return mount === undefined ? Promise.resolve(undeclared('cron')) : mount.serve(request);
}

/**
 * Handlers for the cron mount: `POST <at>/<name>` triggers the feature
 * schedule `<name>` through `mounts.cron.router`. The bearer secret is
 * checked first (401 otherwise); an unknown name is 404.
 *
 * @example
 * export const Route = createFileRoute('/api/cron/$')({ server: { handlers: cronHandlers() } });
 */
export function cronHandlers() {
  return { POST: serveCron };
}

function serveAuth({ request, context }: MountArgs<'auth'>): Promise<Response> {
  const mount = context.services.tanstackStart.mounts.auth;
  return mount === undefined ? Promise.resolve(undeclared('auth')) : mount.serve(request);
}

/**
 * Handlers for the auth mount: `GET` and `POST` go to `mounts.auth.serve`
 * (such as Better Auth's request handler).
 *
 * @example
 * export const Route = createFileRoute('/api/auth/$')({ server: { handlers: authHandlers() } });
 */
export function authHandlers() {
  return { GET: serveAuth, POST: serveAuth };
}

function serveHealth({ context }: Pick<MountArgs<'health'>, 'context'>): Response {
  if (context.services.tanstackStart.mounts.health === undefined) return undeclared('health');
  return Response.json({ status: 'ok' }, { status: 200 });
}

/**
 * Handlers for the health probe: `GET` answers `{ status: 'ok' }`. It only
 * runs once the app has started; before that `startServer` answers 503.
 *
 * @example
 * export const Route = createFileRoute('/api/health')({ server: { handlers: healthHandlers() } });
 */
export function healthHandlers() {
  return { GET: serveHealth };
}
