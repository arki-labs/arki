/**
 * Public pip contract for the DOT kernel (v2).
 *
 * A pip declares what it **needs** as a shape of type witnesses and
 * publishes what it **provides** from its `boot` hook. The kernel wires
 * services by key, injects them into hook contexts under the pip's local
 * aliases, and fails loudly (coded errors) on unsatisfied needs or key
 * collisions.
 *
 * Design constraints:
 *
 *  - `configure` is SYNC. Returning a Promise is an error — the kernel
 *    throws {@link DotLifecycleError} with code `DOT_LIFECYCLE_E001`.
 *  - Declaration order IS boot order. The app builder's type-level guard
 *    makes out-of-order composition a compile error; the kernel re-validates
 *    at runtime for erased/dynamic composition.
 *  - `stop` and `dispose` run in reverse declaration order and continue
 *    through individual pip failures, reporting an aggregate error.
 */

import type { RouteTransport, ServiceKind } from './manifest.js';

declare const TypeOf: unique symbol;

/**
 * Phantom type witness for a service. Carries `T` at the type level only —
 * the runtime value is an empty object.
 */
export type Service<T> = { readonly [TypeOf]?: T };

declare const LazyInner: unique symbol;

/**
 * A lazy-lifting witness (create via {@link service.lazy}). The consumer
 * always receives a `Lazy<T>` handle, regardless of whether the provider
 * published a plain `T` (the kernel lifts it into a pre-initialized
 * handle) or a `Lazy<T>` (passed through). This decouples consumers from
 * the provider's eager-vs-lazy strategy.
 *
 * The phantom `Service<T | Lazy<T>>` base is what the wiring guard checks
 * against — either provider shape satisfies it structurally.
 */
export type LazyService<T> = Service<T | Lazy<T>> & {
  readonly lazy: true;
  readonly [LazyInner]?: T;
};

/**
 * Create an app-local (anonymous) service witness for a `needs` shape.
 *
 * `service.lazy<T>()` creates a lifting witness instead — the hook context
 * delivers a `Lazy<T>` handle whether the provider is eager or lazy.
 */
export const service: (<T>() => Service<T>) & { readonly lazy: <T>() => LazyService<T> } = Object.assign(
  <T,>(): Service<T> => ({}),
  { lazy: <T,>(): LazyService<T> => ({ lazy: true }) },
);

/** Internal (kernel) check: is this witness a lazy-lifting one? */
export function isLazyWitness(witness: object): boolean {
  return 'lazy' in witness && (witness as { lazy?: unknown }).lazy === true;
}

/**
 * Shared, named witness — a cross-package service contract. The `key` is
 * the wire name used for satisfaction checks and runtime lookup; the local
 * property name in a `needs` shape becomes a free-choice alias.
 *
 * @example
 * ```ts
 * // packages/db owns the contract:
 * export const Db = token<NodePgDatabase<Schema>>()('arki.db');
 *
 * // any consumer, any local alias:
 * const reports = pip({
 *   name: 'reports',
 *   needs: { db: Db },
 *   async boot({ db }) { ... },
 * });
 * ```
 */
export type Token<T, K extends string = string> = Service<T> & {
  readonly key: K;
  /** Derive a token for an additional instance of the same contract. */
  instance<N extends string>(name: N): Token<T, `${K}#${N}`>;
};

/**
 * Create a token. Curried so `T` is explicit while `K` is inferred as a
 * literal: `const Db = token<DbHandle>()('arki.db')`.
 */
export function token<T>(): <K extends string>(key: K) => Token<T, K> {
  return <K extends string>(key: K): Token<T, K> => ({
    key,
    instance<N extends string>(name: N): Token<T, `${K}#${N}`> {
      // Safe by construction: the runtime string is exactly the template type.
      return token<T>()(`${key}#${name}` as `${K}#${N}`);
    },
  });
}

/**
 * Publish a value under a token's wire key. Returns a record typed by the
 * token's literal key, so `boot: () => provide(Db, handle)` infers
 * `TProvides = { 'arki.db': DbHandle }`.
 */
export function provide<T, K extends string>(tok: Token<T, K>, value: T): { [P in K]: T } {
  // Safe by construction: the computed key is exactly `tok.key: K`.
  return { [tok.key]: value } as { [P in K]: T };
}

/** Record of wire-keyed services. */
export type ServiceRecord = Record<string, unknown>;

/** Runtime brand for lazy service handles (kernel detects these for auto-dispose). */
export const LazyTag: unique symbol = Symbol('dot.lazy');

/**
 * A lazily-initialized service handle. Publish one from `boot` to defer an
 * expensive open until first use:
 *
 * ```ts
 * boot: () => ({ db: lazy(() => openDb(), { dispose: db => db.close() }) })
 * ```
 *
 * Laziness is visible in the type — consumers declare
 * `needs: { db: service<Lazy<Db>>() }` and call `await db.get()`. The
 * kernel auto-disposes initialized handles in reverse declaration order
 * during `dispose` (and boot rollback), even when the publishing pip has
 * no `dispose` hook. A handle that was never `get()`ed never initializes
 * and never runs cleanup.
 */
export type Lazy<T> = {
  readonly [LazyTag]: true;
  /**
   * Initialize (once) and return the value. Concurrent callers share one
   * attempt. A failed attempt is NOT cached — the next call retries.
   * Throws if the handle has been disposed.
   */
  get(): Promise<T>;
  /** True once an initialization attempt has succeeded. */
  readonly initialized: boolean;
  /** The value if initialized, else `undefined`. Never triggers initialization. */
  peek(): T | undefined;
  /**
   * Run cleanup if initialized (awaits an in-flight initialization first).
   * Idempotent. Called automatically by the kernel for published handles.
   */
  dispose(): Promise<void>;
};

type LazyState<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'pending'; readonly promise: Promise<T> }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'disposed' };

/**
 * Create a lazy service handle. See {@link Lazy} for semantics.
 *
 * @param init - Opens the resource. Runs at most once concurrently; a
 *   rejected attempt is not cached, so a later `get()` retries.
 * @param options.dispose - Cleanup for the initialized value. Skipped when
 *   the handle was never initialized.
 */
export function lazy<T>(
  init: () => Promise<T> | T,
  options: { readonly dispose?: (value: T) => Promise<void> | void } = {},
): Lazy<T> {
  let state: LazyState<T> = { status: 'idle' };

  return {
    [LazyTag]: true,
    get(): Promise<T> {
      if (state.status === 'ready') return Promise.resolve(state.value);
      if (state.status === 'pending') return state.promise;
      if (state.status === 'disposed') {
        return Promise.reject(new Error('Lazy service handle is disposed — the app has shut down.'));
      }
      const promise = Promise.resolve()
        .then(init)
        .then(
          value => {
            state = { status: 'ready', value };
            return value;
          },
          (error: unknown) => {
            // Failed initialization is not cached — allow retry.
            state = { status: 'idle' };
            throw error;
          },
        );
      state = { status: 'pending', promise };
      return promise;
    },
    get initialized(): boolean {
      return state.status === 'ready';
    },
    peek(): T | undefined {
      return state.status === 'ready' ? state.value : undefined;
    },
    async dispose(): Promise<void> {
      if (state.status === 'pending') {
        try {
          await state.promise;
        } catch {
          // Failed init: nothing to clean up.
        }
      }
      if (state.status === 'ready') {
        const { value } = state;
        state = { status: 'disposed' };
        await options.dispose?.(value);
        return;
      }
      state = { status: 'disposed' };
    },
  };
}

/** Type guard: is this published value a lazy service handle? */
export function isLazy(value: unknown): value is Lazy<unknown> {
  return typeof value === 'object' && value !== null && LazyTag in value;
}

/**
 * Wrap an already-available value in a pre-initialized `Lazy<T>` handle.
 * Used by the kernel to lift eager provides for `service.lazy` consumers;
 * also handy for handing fakes to lazy-consuming pips in tests. The handle
 * has no cleanup of its own — the underlying value's lifecycle belongs to
 * whoever created it.
 */
export function lazyOf<T>(value: T): Lazy<T> {
  let disposed = false;
  return {
    [LazyTag]: true,
    get: () =>
      disposed
        ? Promise.reject(new Error('Lazy service handle is disposed — the app has shut down.'))
        : Promise.resolve(value),
    get initialized(): boolean {
      return !disposed;
    },
    peek: () => (disposed ? undefined : value),
    async dispose(): Promise<void> {
      disposed = true;
    },
  };
}

/** A `needs` declaration: local alias → witness (anonymous or token). */
export type NeedsShape = Record<string, Service<unknown>>;

// `{}` is the correct identity for intersection-accumulation in the app
// builder and the correct "no needs / no provides" default.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type EmptyShape = {};

/**
 * Local-alias view of a needs shape — what lifecycle hooks destructure.
 * `{ cache: Token<KV, 'arki.kv'> }` → `{ cache: KV }`.
 * `{ search: service.lazy<S>() }` → `{ search: Lazy<S> }`.
 */
export type CtxOf<S extends NeedsShape> = {
  [K in keyof S]: S[K] extends LazyService<infer T> ? Lazy<T> : S[K] extends Service<infer T> ? T : never;
};

/**
 * Wire-key view of a needs shape — what the app builder checks
 * satisfaction against. Tokens contribute their owned key; anonymous
 * witnesses contribute the property name.
 * `{ cache: Token<KV, 'arki.kv'> }` → `{ 'arki.kv': KV }`.
 */
export type WireNeeds<S extends NeedsShape> = {
  [K in keyof S as S[K] extends Token<unknown, infer WK> ? WK : K]: S[K] extends Service<infer T> ? T : never;
};

/**
 * No `$`-prefixed keys — that prefix is the kernel context namespace
 * ({@link KernelCtx}). Used as a constraint on needs shapes and provides
 * records: a matching key makes the property type `never`, which no
 * witness or service value satisfies, so the violation errors at the
 * exact offending property. The kernel re-validates at runtime with
 * `DOT_LIFECYCLE_E014` for paths the constraint cannot see (renames,
 * erased pips).
 */
export type NoReservedKeys = Readonly<Record<`$${string}`, never>>;

/**
 * Kernel-supplied context keys, present in every service-carrying hook
 * context. The `$` prefix is a reserved namespace: `pip()` rejects
 * `$`-prefixed needs aliases and publish keys at compile time (via
 * {@link NoReservedKeys}) and the kernel enforces it at runtime
 * (`DOT_LIFECYCLE_E014`), so these keys can never be shadowed.
 */
export type KernelCtx = {
  /** App name (passed to `defineApp`). */
  readonly $app: string;
  /** This pip's name. */
  readonly $pip: string;
  /** Read-only runtime config bag from `defineApp(name, { config })`. */
  readonly $config: Readonly<Record<string, unknown>>;
};

/** Context provided to a `configure` hook (sync registration only). */
export type DotConfigureContext = {
  pipName: string;
  /** App name. */
  appName: string;
  /**
   * Register a service this pip publishes, for manifest/diagnostics
   * purposes. Registration is metadata-only — the actual service instance
   * is returned from the `boot` hook.
   */
  registerService(name: string, kind: ServiceKind): void;
  /**
   * Register a route this pip exposes. The optional `description`,
   * `input`/`output` JSON Schemas, and `streaming` flag flow into
   * `manifest.routes` untouched — `dot explain --openapi` renders from
   * them without booting the app.
   */
  registerRoute(route: {
    id: string;
    method?: string;
    path?: string;
    transport: RouteTransport;
    description?: string;
    input?: {
      readonly query?: Readonly<Record<string, unknown>>;
      readonly body?: Readonly<Record<string, unknown>>;
    };
    output?: Readonly<Record<string, unknown>>;
    streaming?: boolean;
  }): void;
  /** Mark the pip as participating in a lifecycle hook. */
  registerLifecycleHook(hook: 'configure' | 'boot' | 'start' | 'stop' | 'dispose'): void;
  /** Append `provides` capability strings (informational, manifest-only). */
  declareProvides(...capabilities: string[]): void;
};

type MaybePromise<T> = T | Promise<T>;

declare const NeedsSym: unique symbol;
declare const ProvidesSym: unique symbol;

/**
 * The DOT pip (v2). Author through {@link pip} — never construct directly.
 *
 * Hook signatures are type-erased here (`ctx: never`): the typed view
 * lives on `pip()`'s parameter, and `(ctx: Typed) => R` is assignable to
 * `(ctx: never) => R` without casts (parameter contravariance from the
 * bottom type). The kernel crosses the erasure boundary at the call site.
 *
 * The phantom symbol properties carry `TNeeds` / `TProvides` for the app
 * builder's compile-time wiring check; they never exist at runtime.
 */
export type Pip<
  TNeeds extends ServiceRecord = ServiceRecord,
  TProvides extends ServiceRecord = ServiceRecord,
> = {
  /** Unique identifier for this pip within the app. */
  readonly name: string;
  /** Optional semantic version string. */
  readonly version?: string;
  /** Runtime needs shape (local alias → witness). */
  readonly needs: NeedsShape;
  /** Mount-time renames: publish key → new wire key (see {@link rename}). */
  readonly renames: Readonly<Record<string, string>>;
  readonly hooks: {
    readonly configure?: (ctx: DotConfigureContext) => void;
    readonly boot?: (ctx: never) => MaybePromise<ServiceRecord | void>;
    readonly start?: (ctx: never) => MaybePromise<void>;
    readonly stop?: (ctx: never) => MaybePromise<void>;
    readonly dispose?: (ctx: never) => MaybePromise<void>;
  };
  readonly [NeedsSym]?: TNeeds;
  readonly [ProvidesSym]?: TProvides;
};

/** Extract a pip's (wire-keyed) needs record. */
export type PipNeeds<P> = P extends Pip<infer N, ServiceRecord> ? N : never;
/** Extract a pip's (wire-keyed) provides record. */
export type PipProvides<P> = P extends Pip<ServiceRecord, infer Pr> ? Pr : never;

/** Internal type alias used by the kernel to erase pip service generics. */
export type AnyPip = Pip<ServiceRecord, ServiceRecord>;

/**
 * Author a DOT pip.
 *
 * - `TShape` is inferred from the `needs` object literal.
 * - `TProvides` is inferred from `boot`'s return type — no generic argument.
 * - `boot({ db, log, $app })` destructures typed services under the local
 *   aliases declared in `needs`, plus the `$`-prefixed kernel keys.
 * - `start` / `stop` / `dispose` additionally receive the pip's own
 *   provides. Reverse-order teardown guarantees needs are still alive in
 *   `dispose`.
 *
 * @example
 * ```ts
 * export const billing = pip({
 *   name: 'billing',
 *   needs: { db: service<Db>(), log: service<Logger>() },
 *   async boot({ db, log }) {
 *     return { billing: new BillingService(db, log) };
 *   },
 *   async dispose({ billing }) {
 *     await billing.flush();
 *   },
 * });
 * ```
 */
/**
 * A `boot` that returns `void` gives `TProvides` no inference candidate,
 * and TypeScript then substitutes the CONSTRAINT (`ServiceRecord & …`,
 * whose `keyof` is `string`) rather than the declared default. That wide
 * record would poison the app builder's collision check for every later
 * `.use()` — `keyof TAvail & string` is never empty. Detect the fallback
 * by its tell (a full string index signature — no `pip()`-authored
 * provides record has one) and collapse it to "provides nothing".
 */
export type InferredProvides<TP extends ServiceRecord> = string extends keyof TP ? EmptyShape : TP;

export function pip<
  TShape extends NeedsShape & NoReservedKeys = EmptyShape,
  TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
>(def: {
  readonly name: string;
  readonly version?: string;
  readonly needs?: TShape;
  readonly configure?: (ctx: DotConfigureContext) => void;
  readonly boot?: (ctx: CtxOf<TShape> & KernelCtx) => MaybePromise<TProvides | void>;
  readonly start?: (ctx: CtxOf<TShape> & TProvides & KernelCtx) => MaybePromise<void>;
  readonly stop?: (ctx: CtxOf<TShape> & TProvides & KernelCtx) => MaybePromise<void>;
  readonly dispose?: (ctx: CtxOf<TShape> & TProvides & KernelCtx) => MaybePromise<void>;
}): Pip<WireNeeds<TShape>, InferredProvides<TProvides>> {
  return {
    name: def.name,
    ...(def.version === undefined ? {} : { version: def.version }),
    needs: def.needs ?? {},
    renames: {},
    hooks: {
      ...(def.configure === undefined ? {} : { configure: def.configure }),
      ...(def.boot === undefined ? {} : { boot: def.boot }),
      ...(def.start === undefined ? {} : { start: def.start }),
      ...(def.stop === undefined ? {} : { stop: def.stop }),
      ...(def.dispose === undefined ? {} : { dispose: def.dispose }),
    },
  };
}

/** Rename a pip's published wire keys — the multi-instance primitive. */
export type RenamedProvides<TP, M> = {
  [K in keyof TP as K extends keyof M ? (M[K] extends string ? M[K] : K) : K]: TP[K];
};

/**
 * Mount-time rename. `rename(dbPip, { db: 'reportsDb' }, 'reports-db')`
 * publishes the same service under a different wire key, retyped
 * accordingly — the way to mount a second instance of an adapter without
 * a key collision. Renames compose: renaming an already-renamed key
 * rewrites the earlier entry.
 */
export function rename<
  TN extends ServiceRecord,
  TP extends ServiceRecord,
  const M extends { readonly [K in keyof TP]?: string },
>(p: Pip<TN, TP>, map: M, newName?: string): Pip<TN, RenamedProvides<TP, M>> {
  const renames: Record<string, string> = { ...p.renames };
  for (const [wireKey, next] of Object.entries(map)) {
    if (typeof next !== 'string') continue;
    // If `wireKey` is itself the *result* of an earlier rename, rewrite that
    // entry (compose); otherwise it is a local publish key.
    const localKey = Object.entries(renames).find(([, w]) => w === wireKey)?.[0] ?? wireKey;
    renames[localKey] = next;
  }
  // Phantom-only cast: runtime fields are unchanged except `renames`/`name`;
  // only the [ProvidesSym] carrier retypes.
  return { ...p, name: newName ?? p.name, renames } as Pip<TN, RenamedProvides<TP, M>>;
}

/**
 * Stable error thrown by DOT pip adapters.
 *
 * Adapters MUST throw `DotPipError` (not raw `Error`) when surfacing a
 * misconfiguration, missing-input, or other fail-fast condition. Consumers
 * and coding agents can then match on a stable `code`, follow `docsUrl`,
 * and apply `remediation` without parsing the message.
 *
 * Codes are per-adapter. Recommended prefix is `<PKG>_PIP_E<NNN>` (e.g.
 * `KV_PIP_E001`, `DB_PIP_E001`). The kernel does not own the code
 * namespace — each adapter defines its own constants and links them in
 * its README.
 *
 * @see packages/dot/docs/principles.md — principle 1.3 ("errors are part
 * of the API") and principle 4 ("agent-discoverable everywhere").
 */
export class DotPipError extends Error {
  /** Stable error code, e.g. `KV_PIP_E001`. */
  readonly code: string;
  /** One-sentence guidance on how to fix the underlying problem. */
  readonly remediation: string;
  /** URL of the documentation page that explains this error. */
  readonly docsUrl: string;

  constructor(args: {
    readonly code: string;
    readonly message: string;
    readonly remediation: string;
    readonly docsUrl: string;
  }) {
    super(args.message);
    this.name = 'DotPipError';
    this.code = args.code;
    this.remediation = args.remediation;
    this.docsUrl = args.docsUrl;
  }
}

/** Re-exported for downstream typing. */

export { type DotAppManifest, type PipManifest } from './manifest.js';
