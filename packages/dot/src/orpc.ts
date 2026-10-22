/**
 * `@arki/dot/orpc` — oRPC procedures for `defineFeature` features, contract first.
 *
 * Design: RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`, Part B.
 *
 *   // app: core/orpc.ts
 *   export const bind = needsMiddleware<RequestContext>();
 *
 *   // features/digest/feature.ts
 *   const digestDeps = defineFeature('digest').needs({ plans }).infra(store);
 *   export type Deps = DepsOf<typeof digestDeps>;
 *   export const digestLogic = digestDeps.usecases({ preview });
 *   export const rpcImplementer = implement(digestRpcContract).$context<RequestContext>().use(bind(digestLogic));
 *   export const digest = digestLogic.entrypoints(rpc(digestRpcContract, rpcImplementer, digestProcedures));
 *
 *   // features/digest/entrypoints/procedures.ts — `import type` only, so no runtime back-import
 *   import type { rpcImplementer } from '../feature';
 *   export const digestProcedures = {
 *     preview: (impl: typeof rpcImplementer) => impl.preview.handler(({ context }) => context.usecases.preview()),
 *   };
 *
 * Two pieces:
 *
 * - `needsMiddleware<Ctx>()` makes the app's `bind`. `bind(digestLogic)` puts the
 *   feature's needs, private infra and usecases on the handler context, by
 *   alias, read from the request's services bag. The request context keeps
 *   request data only (`session`, `headers`, `services`); the feature's
 *   dependencies are declared once, in its chain, where `dot explain` sees them.
 * - `rpc(contract, implementer, factories)` is the entrypoint descriptor. The
 *   factories object is shaped like the contract (a group is a nested
 *   object); each leaf is `(impl) => impl.<path>.handler(…)`. Keys match the
 *   contract exactly: an extra key, a missing key or a procedure that does not
 *   implement its key do not compile.
 *   Each procedure also becomes a manifest action, so `dot explain` lists
 *   the feature's procedures and the policy their contract meta declares.
 *
 * `@orpc/server` is an optional peer. Import this module only in an app that
 * serves oRPC; the rest of Dot never loads it.
 */
import type {
  Context,
  ContractProcedure,
  ContractRouter,
  IntersectPick,
  Meta,
  MiddlewareNextFn,
  MiddlewareResult,
  Router,
} from '@orpc/server';
import { ORPCError, os, traverseContractProcedures } from '@orpc/server';

import type { Failure, FailureOf, SuccessOf } from '@arki/failure';
import type { DeclaredErrors } from '@arki/failure/orpc';
import { isFailure } from '@arki/failure';
import { rpcError } from '@arki/failure/orpc';
import { getLogger } from '@arki/log';
import { is, recordSchema } from '@arki/schema';

import type { RpcEntrypoint } from './define-feature.js';
import type { HandleEntries, ServicesBag } from './feature.js';
import type { JsonObject } from './manifest.js';
import type { ActionDeclaration, CtxOf, NeedsShape } from './unit-contract.js';
import { FEATURE_ERROR_CODES, FeatureError } from './feature-error.js';
import { toJsonObject } from './manifest.js';

/** The least a request context carries for `bind`: the services bag the gateway built for this request. */
export type RequestContextShape = { readonly services: ServicesBag };

/** What `bind(logic)` adds to a handler's context: every handle of the feature's logic stage, resolved, under its alias. */
export type BoundContext<H extends NeedsShape> = CtxOf<HandleEntries<H>>;

/** Aliases that would land on top of a request-context key (the app's own extra keys included). */
type Shadowed<Ctx, H> = keyof H & keyof Ctx;

type ShadowGuard<Ctx, H> = [Shadowed<Ctx, H>] extends [never]
  ? unknown
  : { readonly 'DOT: a feature alias shadows a request-context key': Shadowed<Ctx, H> };

/**
 * Make the app's `bind` for its request context type, once:
 * `export const bind = needsMiddleware<RequestContext>()`.
 *
 * `bind(logic)` is an oRPC middleware. It reads the feature's resolved
 * services — the one bag key `<name>.services` the feature unit publishes
 * (needs, private infra, children's provides and usecases, by alias) — and
 * adds them to the context. One key per feature, read by the feature's own
 * name: no per-handle resolution, so a nested feature's remapped needs just
 * work. A missing key → `ARKI_DOT_E026`, naming the feature. Infra services
 * such as `db` reach a handler only when the feature itself needs them — the
 * feature's store does, the procedure does not.
 *
 * An alias equal to a request-context key is a compile error at `bind(logic)`;
 * `session`, `headers`, `services` and `usecases` are already refused by
 * `defineFeature` (and at runtime there, for callers that skip the types).
 */
export function needsMiddleware<Ctx extends RequestContextShape>() {
  const builder = os.$context<Ctx>();
  return <H extends NeedsShape>(logic: { readonly name: string; readonly handles: H } & ShadowGuard<Ctx, H>) =>
    builder.middleware(({ context, next }) => {
      const key = `${logic.name}.services`;
      const services = context.services[key];
      if (services === undefined) {
        throw new FeatureError({
          code: FEATURE_ERROR_CODES.missingCapability,
          message: `[feature] "${logic.name}": its services ("${key}") are not in the request context's bag.`,
          remediation:
            "Spread providesOf(units) over the features' units() into the gateway's needs and pass servicesOf(ctx, units) to createContext.",
        });
      }
      return next({
        // Erasure seam: the kernel built this record from the unit's needs, which the
        // chain typed as the feature's handles. oRPC asks that new context keys agree
        // with the current ones (`IntersectPick`); no alias is a request key — the
        // guard above proves it — but TypeScript cannot see that through a generic `H`.
        context: services as BoundContext<H> & IntersectPick<Ctx, BoundContext<H>>,
      });
    });
}

/** The oRPC middleware {@link step} makes: reads `In`, adds `Added`, or refuses with `Refused`. */
export type StepMiddleware<In, Added extends Context, Refused extends Failure> = <TOutput>(options: {
  readonly context: In;
  readonly next: MiddlewareNextFn<TOutput>;
  readonly errors: DeclaredErrors<Refused>;
}) => Promise<MiddlewareResult<Added, TOutput>>;

/** The oRPC middleware {@link around} makes: wraps the rest of the chain and the handler, adds nothing. */
export type AroundMiddleware<In> = <TOutput>(options: {
  readonly context: In;
  readonly next: MiddlewareNextFn<TOutput>;
}) => Promise<MiddlewareResult<Record<never, never>, TOutput>>;

/**
 * Run a step before an oRPC procedure: `impl.refund.use(step(authed))`.
 *
 * A step is a plain function. Its parameter is the least context it reads; it
 * returns an object to add to the context, or a failure to refuse the call:
 *
 *   const authed = (ctx: { principal: Principal | null }) =>
 *     ctx.principal === null ? AuthenticationRequired() : { principal: ctx.principal };
 *
 * A refusal is thrown as the typed `ORPCError` the procedure declares, so a
 * procedure that does not list the step's failures (the contract's errors, or
 * `.errors(errorMap(...))`) does not compile. oRPC hands a middleware the
 * procedure's whole error map; the `errors` parameter asks only for the codes
 * the step can refuse with. The same function attaches to the other
 * transports with their own `step`.
 */
export function step<In extends Context, R extends object | PromiseLike<object>>(
  fn: (context: In) => R,
): StepMiddleware<In, Extract<SuccessOf<(context: In) => R>, Context>, FailureOf<(context: In) => R>>;
// Erasure seam: `SuccessOf` of a generic `R` does not narrow under `isFailure`, so
// the body is written against `Context` and the overload above carries the types.
export function step(fn: (context: Context) => unknown): unknown {
  return async (options: {
    readonly context: Context;
    readonly next: (options: { readonly context: unknown }) => unknown;
    readonly errors: DeclaredErrors<Failure>;
  }) => {
    const value: unknown = await fn(options.context);
    if (isFailure(value)) throw rpcError(value, options.errors);
    return options.next({ context: value });
  };
}

/**
 * Wrap an oRPC procedure: `impl.refund.use(around(inTransaction))`.
 *
 * An around is a plain function that runs `next` inside whatever it sets up
 * (a transaction, a retry, a span, a timeout) and returns what `next` returns.
 * It never sees the result's shape, so the same function attaches to every
 * transport with that transport's `around`:
 *
 *   const inTransaction = <T>(ctx: { db: Db }, next: () => Promise<T>) => ctx.db.transaction(() => next());
 *
 * It wraps everything declared after it: later steps and the handler.
 */
export function around<In extends Context>(
  fn: <T>(context: In, next: () => Promise<T>) => Promise<T>,
): AroundMiddleware<In> {
  return async options => fn(options.context, async () => options.next());
}

/** What `errorCaptureMiddleware` hands its reporter with the error. */
export type ErrorCaptureInfo = { readonly path: readonly string[] };

/**
 * Make the app's error capture, once:
 * `export const errorCapture = errorCaptureMiddleware({ report: (error, { path }) => captureException(error) })`.
 *
 * The middleware reports a procedure's unexpected failures, then rethrows them
 * unchanged: capture never changes the response. An `ORPCError` below 500
 * (`UNAUTHORIZED`, `BAD_REQUEST`, …) is normal traffic, not an incident, and
 * is not reported. `report` is called synchronously; a reporter that throws is
 * logged at warn and ignored, so the caller still gets the procedure's own error.
 * Written on an empty context, it fits any app's implementer.
 */
export function errorCaptureMiddleware(options: {
  readonly report: (error: unknown, info: ErrorCaptureInfo) => void;
}) {
  const logger = getLogger('arki:dot:orpc');
  return os.middleware(async ({ next, path }) => {
    try {
      return await next();
    } catch (error) {
      const isClientError = error instanceof ORPCError && error.status < 500;
      if (!isClientError) {
        try {
          options.report(error, { path });
        } catch (reportError) {
          logger.warn('errorCapture: the reporter threw on {procedure}; the error was not reported', {
            procedure: path.join('.'),
            reportError: String(reportError),
          });
        }
      }
      throw error;
    }
  });
}

/**
 * Shaped like the contract: a leaf is `(impl) => impl.<path>.handler(…)`, a group
 * is a nested object — or, for a mounted child feature, `() => child.router`,
 * the child's whole router under the key the contract gives it.
 * `Router<C[K], never>` is oRPC's own "implements" check for one procedure
 * (or one subtree) — same schemas — and `never` as the initial context
 * accepts whatever context the app's implementer settled on.
 */
export type ProcedureFactories<C, O> = {
  readonly [K in keyof C]: C[K] extends ContractProcedure<infer _I, infer _O, infer _E, infer _M>
    ? (implementer: O) => Router<C[K], never>
    : | ProcedureFactories<C[K], O>
      | (C[K] extends ContractRouter<Meta> ? (implementer: O) => Router<C[K], never> : never);
};

/** The router the factories build: each factory's return under its key. */
export type BuiltRouter<F> = {
  readonly [K in keyof F]: F[K] extends (implementer: never) => infer R ? R : BuiltRouter<F[K]>;
};

// Keys in the factories the contract does not have (a nested group reports the
// inner key). No `${K}.${…}` path string here: that hit TS2589 in the probe.
type ExtraKeys<C, F> = {
  [K in keyof F]: K extends keyof C
    ? F[K] extends (implementer: never) => unknown
      ? never
      : ExtraKeys<C[K], F[K]>
    : K;
}[keyof F];

/** A compile error naming each procedure key the contract does not list. */
export type ContractKeysGuard<C, F> = [ExtraKeys<C, F>] extends [never]
  ? unknown
  : { readonly 'DOT: a procedure key is not in the contract': ExtraKeys<C, F> };

/**
 * The feature's oRPC entrypoint: its contract, and the router built from one
 * factory per procedure. The whole tree lives in one `entrypoints/procedures.ts`;
 * each leaf takes the feature's `rpcImplementer` as a typed parameter, so it
 * never imports the feature at runtime. The contract stays the one list of procedure names: a missing,
 * extra or wrong procedure does not compile. `DefinedFeature.contract` /
 * `.router` are read from this descriptor, so `routerFor(rpcContract,
 * features)` finds the feature by its contract. Its actions (one per
 * procedure, `<feature>.<path>`) are named when the feature compiles, through
 * `actionsOf`. A subtree whose built router IS a declared child's router is
 * the child's: the child names those actions itself, so they are skipped
 * here. An inline group (`admin: impl => ({ … })`) has no child owner and
 * keeps its actions.
 *
 * A usecase need not have a procedure (a cron, a webhook or a `provides`
 * handle may call it), and a procedure need not have a usecase: `rpc` checks
 * against the contract only.
 */
export function rpc<C extends ContractRouter<Meta>, O, const F extends ProcedureFactories<C, O>>(
  contract: C,
  implementer: O,
  factories: F & ContractKeysGuard<C, F>,
): RpcEntrypoint<C, BuiltRouter<F>> {
  // Read now, so a bad `meta` fails where the feature is declared, not at boot.
  const procedures = rpcProcedures(contract);
  // Erasure seam: `buildRouter` walks the factories untyped; `F` already
  // proved each leaf returns its contract's procedure, so the result is `BuiltRouter<F>`.
  const router = buildRouter(implementer, factories) as BuiltRouter<F>;
  return {
    kind: 'rpc',
    key: 'rpc',
    actions: [],
    actionsOf: (feature, children = []) => {
      const mounted = mountedPaths(router, new Set(children.map(child => child.router)));
      return procedures
        .filter(
          procedure => !mounted.some(prefix => procedure.path === prefix || procedure.path.startsWith(`${prefix}.`)),
        )
        .map(procedure => rpcAction(feature, procedure));
    },
    contract,
    router,
    // The router is static: it is the same object before boot and after, so `resolve` just hands it back.
    resolve: () => router,
  };
}

/** The dotted paths in the built router whose value is a declared child's router — the child declares those actions. */
function mountedPaths(
  router: object,
  childRouters: ReadonlySet<unknown>,
  path: readonly string[] = [],
): readonly string[] {
  return Object.entries(router).flatMap(([key, value]: [string, unknown]) => {
    const here = [...path, key];
    if (childRouters.has(value)) return [here.join('.')];
    // A procedure carries `~orpc`; only plain groups are walked.
    if (is(value, recordSchema) && !('~orpc' in value))
      return mountedPaths(value, childRouters, here);
    return [];
  });
}

/** Call every leaf factory with the implementer; a group (a plain object) recurses. */
function buildRouter(implementer: unknown, factories: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(factories).map(([key, value]: [string, unknown]) => [
      key,
      typeof value === 'function'
        ? value(implementer)
        : is(value, recordSchema)
          ? buildRouter(implementer, value)
          : value,
    ]),
  );
}

/** Identifies the layout of an rpc action's `meta`, for tools that read `dot explain --json`. */
export const RPC_ACTION_META_SCHEMA = '@arki/dot/rpc-action-meta@1';

type RpcProcedure = {
  readonly path: string;
  readonly method?: string;
  readonly route?: string;
  readonly summary?: string;
  readonly meta: JsonObject;
};

/** Every procedure of a contract with what `dot explain` shows: path, HTTP route, errors and declared meta. */
function rpcProcedures(contract: ContractRouter<Meta>): readonly RpcProcedure[] {
  const found: RpcProcedure[] = [];
  traverseContractProcedures({ router: contract, path: [] }, ({ contract: procedure, path }) => {
    const { route, meta, errorMap } = procedure['~orpc'];
    const name = path.join('.');
    const detail: JsonObject = { procedure: name };
    if (route.method !== undefined) detail['method'] = route.method;
    if (route.path !== undefined) detail['path'] = route.path;
    if (route.tags !== undefined && route.tags.length > 0) detail['tags'] = [...route.tags];
    if (route.deprecated === true) detail['deprecated'] = true;
    const errors = Object.keys(errorMap);
    if (errors.length > 0) detail['errors'] = errors;
    // Contract meta is where an app declares a procedure's policy (`oc.$meta<{ auth: 'admin' }>()`);
    // copying it here is what makes that policy visible without booting anything.
    if (Object.keys(meta).length > 0) detail['meta'] = jsonMeta(name, meta);
    found.push({
      path: name,
      ...(route.method === undefined ? {} : { method: route.method }),
      ...(route.path === undefined ? {} : { route: route.path }),
      ...(route.summary === undefined ? {} : { summary: route.summary }),
      meta: detail,
    });
  });
  return found;
}

function jsonMeta(procedure: string, meta: Meta): JsonObject {
  try {
    return toJsonObject(meta);
  } catch {
    throw new FeatureError({
      code: FEATURE_ERROR_CODES.rpcMetaNotJson,
      message: `[rpc] procedure "${procedure}" has contract meta that is not plain JSON, so dot explain cannot show it.`,
      remediation:
        'Keep contract meta to strings, numbers, booleans, null, arrays and plain objects (no functions, dates or classes).',
    });
  }
}

/**
 * One manifest action per procedure. The id carries the feature
 * (`digest.preview`): ids are unique per binding across the app. The
 * address is the HTTP route when the contract declares one, else the path.
 */
function rpcAction(feature: string, procedure: RpcProcedure): ActionDeclaration {
  const route = procedure.route === undefined ? undefined : `${procedure.method ?? 'POST'} ${procedure.route}`;
  return {
    id: `${feature}.${procedure.path}`,
    binding: 'rpc',
    direction: 'in',
    address: route ?? procedure.path,
    ...(procedure.summary === undefined ? {} : { summary: procedure.summary }),
    metaSchema: RPC_ACTION_META_SCHEMA,
    meta: procedure.meta,
  };
}
