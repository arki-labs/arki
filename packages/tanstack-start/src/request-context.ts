/**
 * The request context a Dot app hands to TanStack Start, as types only.
 *
 * `startServer(app)` builds one {@link StartRequestContext} per request and
 * passes it to Start's `handler.fetch(request, { context })`. Every server
 * route, server function and loader then reads it as `context`. The app
 * names its type once, in `server.ts`, through {@link RequestContextOf}:
 *
 * ```ts
 * declare module '@tanstack/react-start' {
 *   interface Register {
 *     server: { requestContext: RequestContextOf<typeof app> };
 *   }
 * }
 * ```
 *
 * No runtime code lives here, so the root entry stays browser-safe.
 */
import type { DotAppLifecycle, PluginPhases } from '@arki/dot';
import type { Failure } from '@arki/failure';

/** A server-route path, such as `/api/rpc`: starts with `/`, no trailing slash. */
export type MountPrefix = `/${string}`;

/** The `cors` option of `tanstackStart()`. The type is the source; the internal `corsSchema` is locked to it by a type test. */
export type CorsOptions = {
  /** Origins the rpc mount reflects, such as the app's own URL. */
  readonly origins: readonly string[];
  /** Also reflect any `chrome-extension://` origin (bearer-authenticated extensions). */
  readonly extensions?: boolean | undefined;
};

/**
 * The CORS policy `tanstackStart({ cors })` resolves. The rpc mount asks it
 * which origins to reflect.
 *
 * @example
 * const allowed = context.services.tanstackStart.cors.allows(request.headers.get('origin'));
 */
export type CorsPolicy = {
  /** True when `origin` is listed, or is a browser extension and extensions are on. */
  allows(origin: string | null): origin is string;
};

/** What an rpc mount's `serve` answers: oRPC's `RPCHandler.handle` result shape. */
export type RpcServed = { readonly matched: boolean; readonly response?: Response | undefined };

/**
 * The mounts `tanstackStart({ mounts })` builds, each bound to its `at` and
 * to the plugin's needs. The handler builders (`rpcHandlers()`, …) call them.
 *
 * @example
 * const served = await context.services.tanstackStart.mounts.rpc?.serve(request);
 */
export type MountHandles = {
  readonly rpc: { readonly at: MountPrefix; readonly serve: (request: Request) => Promise<RpcServed> };
  readonly auth: { readonly at: MountPrefix; readonly serve: (request: Request) => Promise<Response> };
  /** Checks the bearer secret, then runs the matched cron procedure (401 / 404 otherwise). */
  readonly cron: { readonly at: MountPrefix; readonly serve: (request: Request) => Promise<Response> };
  readonly health: { readonly at: MountPrefix };
};

/** The mount names, one per handler builder. */
export type MountName = keyof MountHandles;

/** Type-only brand: which mounts the app declared. Never set at runtime (like Dot's `Service<T>`). */
declare const declaredMounts: unique symbol;

/**
 * The service `tanstackStart()` provides as `tanstackStart`. `Declared`
 * names the mounts the app declared, so a server route using a handler for
 * an undeclared mount fails to compile.
 *
 * @example
 * const { rpc, session } = await app.services.tanstackStart.context(request, request.signal);
 */
export type StartService<Rpc, Session, Declared extends MountName = never> = {
  /** Build the plugin's part of one request's context (all of it but `services`). */
  readonly context: (
    request: Request,
    signal: AbortSignal,
  ) => Promise<Omit<StartRequestContext<never, Rpc, Session>, 'services'>>;
  /** The resolved CORS policy for the rpc mount. */
  readonly cors: CorsPolicy;
  /** The declared mounts. */
  readonly mounts: Partial<MountHandles>;
  /** Contravariant on purpose: a service declaring more mounts satisfies a route needing fewer. */
  readonly [declaredMounts]?: (mount: Declared) => void;
};

/** The part of the plugin service a handler builder for `Name` reads. */
export type MountedService<Name extends MountName> = Pick<
  StartService<unknown, unknown, Name>,
  'cors' | 'mounts' | typeof declaredMounts
>;

/**
 * One request's context: the five keys every Start server route, server
 * function and loader reads.
 *
 * @example
 * const today = await context.rpc.digest.today({});
 */
export type StartRequestContext<Services, Rpc, Session> = {
  /** The started app's services. Server routes only (`routes/api/`); everything else uses `rpc`. */
  readonly services: Services;
  /** The in-process RPC client, bound to this request. */
  readonly rpc: Rpc;
  /** The caller's session. Runs at most once per request; later calls share the first result. */
  readonly session: () => Promise<Session>;
  /** A fresh id for this request, for logs and traces. */
  readonly requestId: string;
  /** Aborts when the client goes away. */
  readonly signal: AbortSignal;
};

/** An app's services as `startServer` sees them: its record plus the `tanstackStart` service. */
export type WithStart<Services, Rpc, Session> = Services & { readonly tanstackStart: StartService<Rpc, Session> };

/** The services of any app that mounts `tanstackStart()`. */
export type StartServices = { readonly tanstackStart: StartService<unknown, unknown> };

/** Any Dot app (builder) that mounts `tanstackStart()`. */
export type StartApp = DotAppLifecycle<StartServices, Failure, Failure, PluginPhases>;

/**
 * The request context of an app, inferred from its `tanstackStart()` plugin:
 * `services` from the app, `rpc` and `session` from what `options.rpc` and
 * `options.session` return. Never written by hand.
 *
 * @example
 * declare module '@tanstack/react-start' {
 *   interface Register {
 *     server: { requestContext: RequestContextOf<typeof app> };
 *   }
 * }
 */
export type RequestContextOf<App> =
  App extends DotAppLifecycle<infer Services, infer _Open, infer _Close, infer _Phases>
    ? Services extends { readonly tanstackStart: StartService<infer Rpc, infer Session, infer _Declared> }
      ? StartRequestContext<WithStart<Services, Rpc, Session>, Rpc, Session>
      : never
    : never;
