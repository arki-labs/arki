/**
 * `startServer(app, { hot })` — the server entry of a Dot app on TanStack Start.
 *
 * Per request it serves a built client file when one matches, otherwise it
 * gets the started app (or answers 503), builds the typed request context
 * and calls Start's handler with it:
 *
 * ```ts
 * // start/src/server.ts
 * export const server = startServer(app, { hot: import.meta.hot });
 * export default createServerEntry(server);
 *
 * declare module '@tanstack/react-start' {
 *   interface Register {
 *     server: { requestContext: RequestContextOf<typeof app> };
 *   }
 * }
 * ```
 *
 * The app's runtime is `createAppRuntime` from `@arki/dot/runtime`: one
 * started app per process, and a hot update disposes the old app before the
 * new one starts.
 */
import type { DotAppLifecycle, UnitPhases, ServiceRecord } from '@arki/dot';
import type { Failure } from '@arki/failure';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';

import { createAppRuntime } from '@arki/dot/runtime';
import { isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import { ApplicationUnavailable, failureResponse, thrownResponse } from './failures.js';
import type { StartRequestContext, StartServices, WithStart } from './request-context.js';

export { withForwardedProto } from './forwarded-proto.js';

const log = getLogger('arki:tanstack-start');

/** Start's request handler, as `startServer` calls it. */
export type StartHandler<Context> = (
  request: Request,
  options: { readonly context: Context },
) => Response | Promise<Response>;

/** The options `createAppRuntime` accepts; `hot` and `eager` pass through unchanged. */
type RuntimeOptions = NonNullable<Parameters<typeof createAppRuntime>[1]>;

/**
 * Options of {@link startServer}.
 *
 * @example
 * startServer(app, { hot: import.meta.hot, eager: env.NODE_ENV === 'production', client: new URL('../client/', import.meta.url) });
 */
export type StartServerOptions<Context> = {
  /** `import.meta.hot`: dispose the old app before a hot update starts the new one. */
  readonly hot?: RuntimeOptions['hot'];
  /**
   * Boot the app when the server is created, not on the first request
   * (`createAppRuntime`'s `eager`). Pass `env.NODE_ENV === 'production'`: a
   * production server pays no boot on its first request and shows a boot
   * failure at process start. Leave it off in dev, where Vite re-runs the module.
   */
  readonly eager?: RuntimeOptions['eager'];
  /** Start's handler. Defaults to `createStartHandler(defaultStreamHandler)`. */
  readonly handler?: StartHandler<Context>;
  /**
   * The built client directory (Vite's `dist/client/`), as a URL ending in `/`.
   * Defaults to `../client/` next to the running server script (`dist/server/server.js`).
   */
  readonly client?: URL;
};

/** What `createServerEntry` takes. */
export type StartServer = { readonly fetch: (request: Request) => Promise<Response> };

/** Paths that look like files. Only these try the disk, so SSR routes never pay a failed read. */
const FILE_PATH = /\.[a-z0-9]+$/i;

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function mimeType(pathname: string): string {
  return MIME_TYPES[pathname.slice(pathname.lastIndexOf('.'))] ?? 'application/octet-stream';
}

function defaultClientDir(): URL | undefined {
  const script = process.argv[1];
  return script === undefined ? undefined : new URL('../client/', pathToFileURL(script));
}

/** A built client file, a 404 for a path no file can have, or `undefined` to fall through to Start. */
async function clientFile(request: Request, client: URL): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  if (!FILE_PATH.test(pathname)) return undefined;
  let file: string;
  try {
    file = fileURLToPath(new URL(`.${pathname}`, client));
  } catch {
    // An encoded slash (`%2F`, scanner probes) makes the file URL invalid: no client file has that name.
    return new Response('Not Found', { status: 404 });
  }
  let data: Uint8Array<ArrayBuffer>;
  try {
    data = new Uint8Array(await readFile(file));
  } catch {
    return undefined;
  }
  return new Response(data, {
    headers: {
      'Content-Type': mimeType(pathname),
      // Content-hashed files under /assets/ never change. Icons, manifest and service worker can.
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    },
  });
}

/** The boot failure stays in the logs; the client only learns to retry. */
function unavailable(failure: Failure): Response {
  log.error('Application unavailable', { code: failure.code, failure });
  return failureResponse(ApplicationUnavailable());
}

/** Start's own handler, typed for any app's context. */
type AnyStartContext = StartRequestContext<StartServices, unknown, unknown>;

/**
 * The server entry of a Dot app on TanStack Start. Pass the result to
 * `createServerEntry`.
 *
 * Per request: a built client file under the `client` directory is served
 * directly (immutable cache under `/assets/`, one hour elsewhere, 404 for
 * `%2F` probes). Otherwise the started app is fetched; a boot failure is
 * logged and answered 503 without its cause. The request context
 * (`services`, `rpc`, `session`, `requestId`, `signal`) then goes to Start
 * as `handler(request, { context })`. Its type is `RequestContextOf<typeof app>`.
 *
 * @example
 * export const server = startServer(app, { hot: import.meta.hot });
 * export default createServerEntry(server);
 */
export function startServer<Services extends ServiceRecord, Rpc, Session>(
  app: DotAppLifecycle<WithStart<Services, Rpc, Session>, Failure, Failure, UnitPhases>,
  options: StartServerOptions<StartRequestContext<WithStart<Services, Rpc, Session>, Rpc, Session>> = {},
): StartServer {
  const runtime = createAppRuntime(app, { hot: options.hot, eager: options.eager });
  const handler: StartHandler<StartRequestContext<WithStart<Services, Rpc, Session>, Rpc, Session>> =
    options.handler ?? createStartHandler<{ server: { requestContext: AnyStartContext } }>(defaultStreamHandler);
  const client = options.client ?? defaultClientDir();

  return {
    async fetch(request) {
      const file = client === undefined ? undefined : await clientFile(request, client);
      if (file !== undefined) return file;
      const started = await runtime.get();
      if (isFailure(started)) return unavailable(started);
      let own: Awaited<ReturnType<typeof started.services.tanstackStart.context>>;
      try {
        own = await started.services.tanstackStart.context(request, request.signal);
      } catch (error) {
        // Identity lookups return `null` or a failure for expected outcomes. A throw is a refusal failure or a crash.
        log.error('Request context failed', { error: error instanceof Error ? error : String(error) });
        return thrownResponse(error);
      }
      return handler(request, { context: { services: started.services, ...own } });
    },
  };
}
