import type { Failure } from '@arki/failure';

/**
 * Route bundles — the dynamic half of an HTTP surface.
 *
 * A bundle binds contracts to handlers. It is assembled inside a plugin's
 * `provides` factory — where the plugin's `needs` are already injected — so
 * handlers and derivers close over typed singletons:
 *
 * ```ts
 * export const OrdersRoutes = token<RouteBundle>()('orders.routes');
 *
 * export const ordersPlugin = plugin({
 *   name: 'orders',
 *   needs: { db: database.provides.db },
 *   actions: [listOrders, createOrder],
 *   provides: {
 *     [OrdersRoutes.key]: ({ db }) =>
 *       routes()
 *         .bind(listOrders, async ({ query }) => db.orders.list(query))
 *         .bind(createOrder, async ({ body }, ctx) => db.orders.create(body, ctx.requestId)),
 *   },
 * });
 * ```
 *
 * The builder accumulates deriver-added context keys in its type — a
 * handler bound after `.derive('principal', …)` sees `ctx.principal`
 * typed. Same accumulation idiom as `defineApp().infra()`.
 */

import type {
  ContractLike,
  CoversFailures,
  FailureDefinitionLike,
  ResponseSchemas,
  RouteContract,
  RouteDef,
  RouteFailure,
  RouteInput,
  SseContract,
  SseDef,
} from './contract.js';
import type { BaseRequestCtx, Deriver, ErasedAround, ErasedStage, ErasedStep, FailureHeaders } from './derive.js';
import type { HttpAround, HttpStep } from './middleware.js';
import type { RawOutput } from './raw.js';
import type { Wire, WireValue } from './wire.js';
import { BASE_CTX_KEYS } from './derive.js';
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';
import { HTTP_ACTION_META_SCHEMA } from './openapi.js';

type MaybePromise<T> = T | Promise<T>;

export const REPLY: unique symbol = Symbol.for('@arki/http/reply');

/** A handler's answer with a chosen status. Create with {@link reply}. */
export type Reply<TStatus extends number, TBody> = {
  readonly [REPLY]: true;
  readonly status: TStatus;
  readonly body: TBody;
  readonly headers?: Readonly<Record<string, string>>;
};

/**
 * Answer with one of the contract's `responses`: `reply(404, { reason })`.
 * The status must be a key of `responses` and the body must fit its schema.
 * Extra `headers` ride along on the response.
 */
export function reply<const TStatus extends number, TBody>(
  status: TStatus,
  body: TBody,
  init: { readonly headers?: Readonly<Record<string, string>> } = {},
): Reply<TStatus, TBody> {
  return { [REPLY]: true, status, body, ...(init.headers === undefined ? {} : { headers: init.headers }) };
}

export function isReply(value: unknown): value is Reply<number, unknown> {
  return typeof value === 'object' && value !== null && REPLY in value;
}

type PlainResult<TDef> = TDef extends { readonly output: infer TOutput }
  ? TOutput extends RawOutput
    ? Response
    : TOutput extends Wire
      ? WireValue<TOutput>
      : never
  : void;

type ReplyResult<TDef> = TDef extends { readonly responses: infer TResponses extends ResponseSchemas }
  ? { [S in keyof TResponses & number]: Reply<S, WireValue<TResponses[S]>> }[keyof TResponses & number]
  : never;

/**
 * What a JSON handler may return, read from the contract:
 *
 *  - `output` schema: its value form, encoded and sent as 200 JSON;
 *  - `output: raw()`: a `Response`, passed through untouched;
 *  - no `output`: nothing, answered 204;
 *  - `reply(status, body)` for any status in `responses`;
 *  - one of the contract's listed `failures`, answered with its status and
 *    the error envelope. A failure the contract does not list is a compile
 *    error.
 */
export type HandlerResult<TDef> = PlainResult<TDef> | ReplyResult<TDef> | RouteFailure<TDef>;

/** Handler signature inferred from a {@link RouteContract}. */
export type RouteHandler<TPath extends string, TDef, TCtx extends BaseRequestCtx> = (
  input: RouteInput<TPath, TDef>,
  ctx: TCtx,
) => MaybePromise<HandlerResult<TDef>>;

/**
 * Handler signature inferred from an {@link SseContract}: an async
 * iterable (usually an async generator) of events. Each yielded value is
 * encoded with the contract's event schema and framed as an SSE
 * `data:` message. Client disconnect aborts `ctx.signal` and terminates
 * the iterator.
 */
export type SseHandler<TPath extends string, TDef extends SseDef<TPath>, TCtx extends BaseRequestCtx> = (
  input: RouteInput<TPath, TDef>,
  ctx: TCtx,
) => AsyncIterable<WireValue<TDef['event']>>;

/** Non-HTTP transports a {@link RouteBundleBuilder.mount} can declare. */
export type MountTransport = 'orpc' | 'trpc' | 'rpc' | 'custom';

export type MountMeta = {
  /** Stable identifier — lands in the manifest like a contract id. */
  readonly id: string;
  /** Manifest transport tag. Defaults to `'custom'`. */
  readonly transport?: MountTransport;
};

/**
 * Lets an outside observer (the Dot adapter's handler events) bracket one
 * request's whole pipeline. `watching` says whether anyone listens right now;
 * when not, the engine takes its plain path and never calls `run`. `run`
 * calls `work` once and returns its value unchanged; `failureOf` names the
 * Failure a settled value stands for (a refusal Response), so the observer
 * can report `refused`. A throw is a failure. The transport core knows no
 * observer type: this is all it is given.
 */
export type ObserveBinding = {
  readonly watching: () => boolean;
  readonly run: <T>(work: () => T, failureOf: (value: unknown) => Failure | undefined) => T;
};

/** A contract bound to its (generics-erased) handler. */
export type RouteBinding = FailureHeaders<Failure> & {
  /** Set by an adapter that watches this route; the engine skips all of it when absent. */
  readonly observe?: ObserveBinding;
  readonly derivers?: readonly ErasedStage[];
  readonly contract: ContractLike;
  /**
   * Stored erased (`never` parameters) — typed handlers are assignable
   * via parameter contravariance from the bottom type; the engine crosses
   * the erasure boundary at the call site. Mirrors the DOT kernel's
   * hook-storage pattern.
   */
  readonly handler: (input: never, ctx: never) => unknown;
};

/** A mounted foreign fetch handler (oRPC/tRPC router, static files, …). */
export type MountBinding = {
  readonly id: string;
  readonly path: string;
  readonly transport: MountTransport;
  readonly handler: (req: Request) => Response | Promise<Response>;
};

/** Manifest declaration an {@link RpcMountDef} produces via `toDotAction()`. */
export type RpcActionMeta = {
  readonly id: string;
  readonly binding: MountTransport;
  readonly direction: 'in';
  readonly address: string;
  readonly summary?: string;
  readonly metaSchema: typeof HTTP_ACTION_META_SCHEMA;
  readonly meta: { readonly path: string; readonly rpc: true };
};

/**
 * The STATIC half of an RPC mount — pure data plus `toDotAction()`, so a
 * feature plugin lists it in `actions:` at module level (declare-once), and
 * binds `context`/`handle` in `boot` where its services exist
 * (bind-once) — the exact contract/handler split `route.get(...)` uses.
 */
export type RpcMountContract = {
  readonly kind: 'rpc-mount';
  readonly failures?: readonly FailureDefinitionLike[];
  /** Stable manifest id, e.g. 'orders.rpc'. */
  readonly id: string;
  /** Path prefix the RPC handler owns, e.g. '/rpc/orders'. */
  readonly path: string;
  readonly transport: MountTransport;
  readonly summary?: string;
  toDotAction(): RpcActionMeta;
};

export type RpcMountOptions = {
  readonly failures?: readonly FailureDefinitionLike[];
  readonly id: string;
  /** Manifest binding name. Defaults to `'orpc'`. */
  readonly transport?: MountTransport;
  readonly summary?: string;
};

/**
 * The boot-time half: a per-request context factory (receives the
 * bundle's accumulated derived ctx, typed) and the dispatch — typically
 * an oRPC `RPCHandler` or tRPC fetch adapter built once at boot.
 */
export type RpcMountHandlers<TDerived extends BaseRequestCtx, TRpcCtx> = {
  readonly context: (req: Request, ctx: TDerived) => TRpcCtx | Promise<TRpcCtx>;
  readonly handle: (req: Request, ctx: NoInfer<TRpcCtx>) => Response | Promise<Response>;
};

/** Erased rpc binding a bundle stores — same seam as {@link RouteBinding}. */
export type RpcBinding = {
  /** Set by an adapter that watches this mount; see {@link ObserveBinding}. */
  readonly observe?: ObserveBinding;
  readonly contract?: RpcMountContract;
  readonly derivers?: readonly ErasedStage[];
  readonly id: string;
  readonly path: string;
  readonly transport: MountTransport;
  readonly context: (req: Request, ctx: never) => unknown;
  readonly handle: (req: Request, ctx: never) => Response | Promise<Response>;
};

/**
 * A mount path. It must start with "/": a relative path is a compile error,
 * and `assertMountPath` still rejects it (and spaces) for code that skips types.
 */
export type MountPath = `/${string}`;

/** Declare the static half of an RPC mount. See {@link RpcMountContract}. */
export function rpcMount<const Options extends RpcMountOptions>(
  path: MountPath,
  options: Options,
): RpcMountContract & Options;
export function rpcMount(path: MountPath, options: RpcMountOptions): RpcMountContract {
  assertMountPath(path, options.id);
  const transport = options.transport ?? 'orpc';
  return {
    ...options,
    kind: 'rpc-mount',
    id: options.id,
    path,
    transport,
    ...(options.summary === undefined ? {} : { summary: options.summary }),
    toDotAction(): RpcActionMeta {
      return {
        id: options.id,
        binding: transport,
        direction: 'in',
        address: path,
        ...(options.summary === undefined ? {} : { summary: options.summary }),
        metaSchema: HTTP_ACTION_META_SCHEMA,
        meta: { path, rpc: true },
      };
    },
  };
}

/**
 * A plain value: derivers + bound contracts + mounts. Published as an
 * ordinary DOT service under a token and collected by the `http()` entrypoint —
 * no new kernel concept.
 */
export type RouteBundle = {
  readonly derivers: readonly ErasedStage[];
  readonly bindings: readonly RouteBinding[];
  readonly mounts: readonly MountBinding[];
  /** Typed RPC mounts — optional so hand-rolled bundles stay valid. */
  readonly rpcs?: readonly RpcBinding[];
};

/**
 * Immutable bundle builder. Every method returns a new builder; deriver
 * keys accumulate in `TCtx` so later `bind` handlers see them typed.
 */
export type RouteBundleBuilder<
  TCtx extends BaseRequestCtx = BaseRequestCtx,
  TFailures extends Failure = never,
> = RouteBundle & {
  /** Add a reusable deriver (see {@link Deriver}). */
  derive<K extends string, V>(
    deriver: Deriver<K, V, TCtx>,
  ): RouteBundleBuilder<
    TCtx & Readonly<Record<K, Exclude<Awaited<V>, Failure>>>,
    TFailures | Extract<Awaited<V>, Failure>
  >;
  /** Add an inline deriver. */
  derive<K extends string, V>(
    key: K,
    fn: (req: Request, ctx: TCtx) => V | Promise<V>,
    options?: FailureHeaders<NoInfer<V>>,
  ): RouteBundleBuilder<
    TCtx & Readonly<Record<K, Exclude<Awaited<V>, Failure>>>,
    TFailures | Extract<Awaited<V>, Failure>
  >;
  /**
   * Run a step before the handler: `routes().use(step(authed))`. The step's
   * object is added to the context; its failures join the bundle's failures,
   * so every route bound after it must declare them. A refusal answers with the
   * same envelope as a refused {@link derive}. See `step`.
   */
  use<R extends object | PromiseLike<object>>(
    step: HttpStep<TCtx, R>,
  ): RouteBundleBuilder<TCtx & Exclude<Awaited<R>, Failure>, TFailures | Extract<Awaited<R>, Failure>>;
  /**
   * Wrap everything declared after it and the handler:
   * `routes().use(around(inTransaction))`. Adds nothing to the context. See `around`.
   */
  use(around: HttpAround<TCtx>): RouteBundleBuilder<TCtx, TFailures>;
  /**
   * Bind a JSON contract to its handler. `NoInfer` pins the input/result
   * types to the contract — without it, a handler returning the wrong
   * shape would silently widen `TDef` instead of failing to compile.
   */
  bind<TPath extends string, TDef extends RouteDef<TPath>>(
    contract: RouteContract<TPath, TDef> & CoversFailures<NoInfer<TDef>, TFailures>,
    handler: RouteHandler<TPath, NoInfer<TDef>, TCtx>,
    options?: FailureHeaders<RouteFailure<NoInfer<TDef>>>,
  ): RouteBundleBuilder<TCtx, TFailures>;
  /** Bind an SSE contract to its event generator. */
  bind<TPath extends string, TDef extends SseDef<TPath>>(
    contract: SseContract<TPath, TDef> & CoversFailures<NoInfer<TDef>, TFailures>,
    handler: SseHandler<TPath, NoInfer<TDef>, TCtx>,
    options?: FailureHeaders<RouteFailure<NoInfer<TDef>>>,
  ): RouteBundleBuilder<TCtx, TFailures>;
  /**
   * Mount a foreign fetch handler under a path prefix — an oRPC router, a
   * tRPC fetch adapter, a static-file handler. One manifest route, no
   * schemas, derivers do NOT run for mounted handlers.
   */
  mount(
    path: MountPath,
    handler: (req: Request) => Response | Promise<Response>,
    meta: MountMeta,
  ): RouteBundleBuilder<TCtx, TFailures>;
  /**
   * Bind a static {@link RpcMountContract} to its boot-time handlers.
   * Unlike `mount`, the bundle's derivers RUN before dispatch, and the
   * context factory receives the accumulated derived ctx — derivers
   * added before `.rpc()` are typed into it.
   */
  rpc<TRpcCtx, const Contract extends RpcMountContract>(
    contract: Contract & CoversFailures<NoInfer<Contract>, TFailures>,
    handlers: RpcMountHandlers<TCtx, TRpcCtx>,
  ): RouteBundleBuilder<TCtx, TFailures>;
};

type BundleState = {
  readonly derivers: readonly ErasedStage[];
  readonly bindings: readonly RouteBinding[];
  readonly mounts: readonly MountBinding[];
  readonly rpcs: readonly RpcBinding[];
};

function assertMountPath(path: string, id: string): void {
  if (!path.startsWith('/') || path.includes(' ')) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.invalidMount,
      message: `[http] mount path "${path}" for "${id}" is invalid — it must start with "/" and contain no spaces.`,
      remediation: 'Mount under an absolute path prefix, e.g. "/rpc".',
    });
  }
}

function assertFreshDeriverKey(key: string, existing: readonly ErasedStage[]): void {
  const reserved = (BASE_CTX_KEYS as readonly string[]).includes(key);
  const duplicate = existing.some(d => 'derive' in d && d.key === key);
  if (!reserved && !duplicate) return;
  throw new HttpConfigError({
    code: HTTP_ERROR_CODES.duplicateDeriverKey,
    message: reserved
      ? `[http] deriver key "${key}" shadows a base request-context key.`
      : `[http] deriver key "${key}" is already derived in this bundle.`,
    remediation: `Pick a different key — base keys (${BASE_CTX_KEYS.join(', ')}) and earlier deriver keys are reserved.`,
  });
}

function makeBuilder(state: BundleState): RouteBundleBuilder;
function makeBuilder(state: BundleState): unknown {
  const impl = {
    derivers: state.derivers,
    bindings: state.bindings,
    mounts: state.mounts,
    rpcs: state.rpcs,
    derive(
      keyOrDeriver: string | Exclude<ErasedStage, ErasedStep | ErasedAround>,
      fn?: (req: Request, ctx: never) => unknown,
      options: FailureHeaders<Failure> = {},
    ): RouteBundleBuilder {
      let deriver: Exclude<ErasedStage, ErasedStep | ErasedAround>;
      if (typeof keyOrDeriver === 'string') {
        if (fn === undefined) {
          throw new HttpConfigError({
            code: HTTP_ERROR_CODES.duplicateDeriverKey,
            message: `[http] derive("${keyOrDeriver}") is missing its deriver function.`,
            remediation: 'Pass derive(key, fn) or derive(deriverObject).',
          });
        }
        deriver = { key: keyOrDeriver, derive: fn, ...options };
      } else {
        deriver = keyOrDeriver;
      }
      assertFreshDeriverKey(deriver.key, state.derivers);
      return makeBuilder({ ...state, derivers: [...state.derivers, deriver] });
    },
    use(stage: ErasedStep | ErasedAround): RouteBundleBuilder {
      return makeBuilder({ ...state, derivers: [...state.derivers, stage] });
    },
    bind(
      contract: ContractLike,
      handler: (input: never, ctx: never) => unknown,
      options: FailureHeaders<Failure> = {},
    ): RouteBundleBuilder {
      return makeBuilder({
        ...state,
        bindings: [...state.bindings, { contract, handler, derivers: state.derivers, ...options }],
      });
    },
    mount(
      path: MountPath,
      handler: (req: Request) => Response | Promise<Response>,
      meta: MountMeta,
    ): RouteBundleBuilder {
      assertMountPath(path, meta.id);
      return makeBuilder({
        ...state,
        mounts: [...state.mounts, { id: meta.id, path, transport: meta.transport ?? 'custom', handler }],
      });
    },
    rpc(contract: RpcMountContract, handlers: RpcMountHandlers<BaseRequestCtx, unknown>): RouteBundleBuilder {
      return makeBuilder({
        ...state,
        rpcs: [
          ...state.rpcs,
          {
            contract,
            derivers: state.derivers,
            id: contract.id,
            path: contract.path,
            transport: contract.transport,
            context: handlers.context,
            handle: handlers.handle,
          },
        ],
      });
    },
  };
  // Public overloads retain inferred contracts, context and failure sets;
  // this implementation stores erased callbacks without altering their values.
  return impl;
}

/** Start an empty bundle. See the module docs for the authoring pattern. */
export function routes(): RouteBundleBuilder {
  return makeBuilder({ derivers: [], bindings: [], mounts: [], rpcs: [] });
}
