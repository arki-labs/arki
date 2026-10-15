/**
 * Public plugin contract for the DOT kernel (v2).
 *
 * A plugin declares what it **needs** as a shape of type witnesses and
 * what it **provides** as one factory per published key. The keys are
 * static, so `plugin.provides` holds a typed handle per key before
 * anything boots. The kernel wires services by key, injects them into
 * hook contexts under the plugin's local aliases, and fails loudly (coded
 * errors) on unsatisfied needs or key collisions.
 *
 * Design constraints:
 *
 *  - `configure` is SYNC. Returning a Promise is an error — the kernel
 *    throws {@link DotLifecycleError} with code `DOT_LIFECYCLE_E001`.
 *  - Declaration order IS boot order. The app builder's type-level guard
 *    makes out-of-order composition a compile error; the kernel re-validates
 *    at configure time from the static `provides` handles.
 *  - `stop` and `dispose` run in reverse declaration order and continue
 *    through individual plugin failures, reporting an aggregate error.
 */

import type { ActionManifest, JsonObject, ProjectionManifest, ServiceKind } from './manifest.js';

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
  <T>(): Service<T> => ({}),
  { lazy: <T>(): LazyService<T> => ({ lazy: true }) },
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
 * const reports = plugin({
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
 * A record holding one value under a token's wire key, typed by the
 * token's literal key: `provide(Db, handle)` is `{ 'arki.db': DbHandle }`.
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
 * A lazily-initialized service handle. Return one from a `provides`
 * factory to defer an expensive open until first use:
 *
 * ```ts
 * provides: { db: () => lazy(() => openDb(), { dispose: db => db.close() }) }
 * ```
 *
 * Laziness is visible in the type — consumers declare
 * `needs: { db: dbPlugin.provides.db }` and call `await db.get()`. The
 * kernel auto-disposes initialized handles in reverse declaration order
 * during `dispose` (and boot rollback), even when the publishing plugin has
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
 * also handy for handing fakes to lazy-consuming plugins in tests. The handle
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
 * erased plugins).
 */
export type NoReservedKeys = Readonly<Record<`$${string}`, never>>;

/**
 * Kernel-supplied context keys, present in every service-carrying hook
 * context. The `$` prefix is a reserved namespace: `plugin()` rejects
 * `$`-prefixed needs aliases and publish keys at compile time (via
 * {@link NoReservedKeys}) and the kernel enforces it at runtime
 * (`DOT_LIFECYCLE_E014`), so these keys can never be shadowed.
 */
export type KernelCtx = {
  /** App name (passed to `defineApp`). */
  readonly $app: string;
  /** This plugin's name. */
  readonly $plugin: string;
  /** Read-only runtime config bag from `defineApp(name, { config })`. */
  readonly $config: Readonly<Record<string, unknown>>;
};

/** Context provided to a `configure` hook (sync registration only). */
export type ActionDeclaration = Omit<ActionManifest, 'plugin'>;

/** Structural protocol for adapter-owned declarations. */
export type ActionSource = ActionDeclaration | { toDotAction(): ActionDeclaration };

export type ProjectionDeclaration = Omit<ProjectionManifest, 'plugin'>;

type LegacyRouteDeclaration = {
  id: string;
  method?: string;
  path?: string;
  transport: string;
  description?: string;
  input?: {
    readonly query?: Readonly<JsonObject>;
    readonly body?: Readonly<JsonObject>;
  };
  output?: Readonly<JsonObject>;
  streaming?: boolean;
};

export type DotConfigureContext = {
  pluginName: string;
  /** App name. */
  appName: string;
  /**
   * Register a service this plugin publishes, for manifest/diagnostics
   * purposes. Registration is metadata-only — the actual service instance
   * is returned from its `provides` factory.
   */
  registerService(name: string, kind: ServiceKind): void;
  /** Register an action this plugin contributes at an app boundary. */
  registerAction(action: ActionDeclaration): void;
  /** Register a projection renderer this plugin contributes. */
  registerProjection(projection: ProjectionDeclaration): void;
  /** @deprecated Use `registerAction`; removed in DOT 0.5.0. */
  registerRoute(route: LegacyRouteDeclaration): void;
  /** Mark the plugin as participating in a lifecycle hook. */
  registerLifecycleHook(hook: 'configure' | 'boot' | 'start' | 'stop' | 'dispose'): void;
  /** Append `provides` capability strings (informational, manifest-only). */
  declareProvides(...capabilities: string[]): void;
};

type MaybePromise<T> = T | Promise<T>;

/** What the kernel passes to a plugin's `logging` factory. */
export type DotLoggingContext = {
  /** App name (passed to `defineApp`). */
  readonly appName: string;
};

/** What a `logging` factory returns. The kernel closes it after the app's last lifecycle record. */
export type DotLoggingHandle = {
  close(): Promise<void>;
};

/**
 * A capability handle: a token on the wire key `K`, stamped with the name
 * of the unit that provides it. `plugin()` and `feature()` mint one per
 * `provides` key, so a consumer names the capability in its `needs`
 * (`needs: { db: database.provides.db }`) and never restates the type —
 * the Drizzle `references(() => table.column)` of services. Identity is
 * the wire key, not the object: the kernel resolves by `key`.
 */
export type Handle<T, K extends string, O extends string = string> = Token<T, K> & {
  readonly provider: O;
  /** The lazy-lifting form of the same handle (the `service.lazy` of handles). */
  readonly lazy: LazyHandle<T, K, O>;
};

/**
 * A handle that always delivers a `Lazy<T>`, whether the provider is eager
 * or lazy — `needs: { db: database.provides.db.lazy }`.
 */
export type LazyHandle<T, K extends string, O extends string = string> = Token<T, K> &
  LazyService<T> & { readonly provider: O };

/** One handle per published key — what `plugin.provides` holds. */
export type Handles<TProvides extends ServiceRecord, O extends string = string> = {
  readonly [K in keyof TProvides & string]: Handle<TProvides[K], K, O>;
};

/** The value type behind a handle — for the one alias an app names (`type Db = Provided<typeof database.provides.db>`). */
export type Provided<H> = H extends Service<infer T> ? T : never;

/** An erased handle — what helpers that only read `key` / `provider` accept. */
export type AnyHandle = Token<unknown> & { readonly provider: string };

/** Mint the handle for wire key `key` provided by `provider` (and its lazy form). */
export function handleOf(key: string, provider: string): Handle<unknown, string> {
  const tok = token<unknown>()(key);
  return { ...tok, provider, lazy: { ...tok, provider, lazy: true } };
}

/** One factory per published key. Each gets the needs + kernel keys; its key is the publish key. */
export type ProvidesFactories<TNeeds extends NeedsShape, TProvides extends ServiceRecord> = {
  readonly [K in keyof TProvides]: (services: CtxOf<TNeeds> & KernelCtx) => MaybePromise<TProvides[K]>;
};

/** An erased factory record — what the kernel runs at boot. */
export type AnyFactories = Readonly<Record<string, (ctx: never) => unknown>>;

declare const NeedsSym: unique symbol;
declare const ProvidesSym: unique symbol;

/**
 * The DOT plugin (v2). Author through {@link plugin} — never construct directly.
 *
 * Hook signatures are type-erased here (`ctx: never`): the typed view
 * lives on `plugin()`'s parameter, and `(ctx: Typed) => R` is assignable to
 * `(ctx: never) => R` without casts (parameter contravariance from the
 * bottom type). The kernel crosses the erasure boundary at the call site.
 *
 * The phantom symbol properties carry `TNeeds` / `TProvides` for the app
 * builder's compile-time wiring check; they never exist at runtime.
 */
/** See {@link Plugin.role}. */
export type DotPluginRole = 'feature' | 'driving';

export type Plugin<TNeeds extends ServiceRecord = ServiceRecord, TProvides extends ServiceRecord = ServiceRecord> = {
  /** Unique identifier for this plugin within the app. */
  readonly name: string;
  /** Optional semantic version string. */
  readonly version?: string;
  /** Runtime needs shape (local alias → witness). */
  readonly needs: NeedsShape;
  readonly actions: readonly ActionSource[];
  /** Mount-time renames: publish key → new wire key (see {@link rename}). */
  readonly renames: Readonly<Record<string, string>>;
  /**
   * Where the app builder mounted this plugin in the hexagon: `feature`
   * (`.features()`) or `driving` (`.serve()`). Absent for `.use()` — a
   * driven adapter, or any plugin in an app that never calls `.features()`.
   */
  readonly role?: DotPluginRole;
  /**
   * One typed handle per published wire key, known before boot. The kernel
   * checks ordering and rings at configure time from these keys, and
   * `dot explain` draws the edges without booting. `rename()` rebuilds
   * them on the new keys.
   */
  readonly provides: Handles<TProvides>;
  /** The `provides` factories, keyed by publish key (before renames). The kernel runs them in key order at boot. */
  readonly factories: AnyFactories;
  /**
   * The logging slot. At most one plugin per app fills it. The kernel calls
   * the factory before its first lifecycle record and closes the handle after
   * its last one (after `dispose`, or after a failed `configure`/`boot`/`start`).
   */
  readonly logging?: (ctx: DotLoggingContext) => DotLoggingHandle;
  readonly hooks: {
    readonly configure?: (ctx: DotConfigureContext) => void;
    readonly boot?: (ctx: never) => MaybePromise<void>;
    readonly start?: (ctx: never) => MaybePromise<void>;
    readonly stop?: (ctx: never) => MaybePromise<void>;
    readonly dispose?: (ctx: never) => MaybePromise<void>;
  };
  readonly [NeedsSym]?: TNeeds;
  readonly [ProvidesSym]?: TProvides;
};

/** Extract a plugin's (wire-keyed) needs record. */
export type PluginNeeds<P> = P extends Plugin<infer N, ServiceRecord> ? N : never;
/** Extract a plugin's (wire-keyed) provides record. */
export type PluginProvides<P> = P extends Plugin<ServiceRecord, infer Pr> ? Pr : never;

/** Internal type alias used by the kernel to erase plugin service generics. */
export type AnyPlugin = Plugin<ServiceRecord, ServiceRecord>;

/**
 * Author a DOT plugin.
 *
 * - `TShape` is inferred from the `needs` object literal.
 * - `TProvides` is inferred from the `provides` factories — no generic
 *   argument. Each factory gets the needs (under their local aliases) plus
 *   the `$`-prefixed kernel keys; it may be async. The kernel runs them in
 *   key order at boot.
 * - `boot` is side effects only: it runs after the factories and sees their
 *   values. Returning a value from it is a compile error — publish through
 *   `provides`.
 * - `start` / `stop` / `dispose` additionally receive the plugin's own
 *   provides. Reverse-order teardown guarantees needs are still alive in
 *   `dispose`.
 *
 * @example
 * ```ts
 * export const billing = plugin({
 *   name: 'billing',
 *   needs: { db: database.provides.db },
 *   provides: { billing: ({ db }) => new BillingService(db) },
 *   async dispose({ billing }) {
 *     await billing.flush();
 *   },
 * });
 * // billing.provides.billing is a typed handle, before anything boots.
 * ```
 */
export function plugin<
  TShape extends NeedsShape & NoReservedKeys = EmptyShape,
  TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
>(def: {
  readonly name: string;
  readonly version?: string;
  readonly needs?: TShape;
  readonly actions?: readonly ActionSource[];
  /** Fill the logging slot (see {@link Plugin.logging}). Called by the kernel, never at import. */
  readonly logging?: (ctx: DotLoggingContext) => DotLoggingHandle;
  readonly configure?: (ctx: DotConfigureContext) => void;
  /** One factory per published key. Each gets the needs + kernel keys. Keys are the publish keys. */
  readonly provides?: ProvidesFactories<TShape, TProvides>;
  /** Side effects only. Runs after the factories and sees their values. */
  readonly boot?: (ctx: CtxOf<TShape> & TProvides & KernelCtx) => MaybePromise<void>;
  readonly start?: (ctx: CtxOf<TShape> & TProvides & KernelCtx) => MaybePromise<void>;
  readonly stop?: (ctx: CtxOf<TShape> & TProvides & KernelCtx) => MaybePromise<void>;
  readonly dispose?: (ctx: CtxOf<TShape> & TProvides & KernelCtx) => MaybePromise<void>;
}): Plugin<WireNeeds<TShape>, TProvides> {
  const factories: AnyFactories = def.provides ?? {};
  const handles: Record<string, AnyHandle> = {};
  for (const key of Object.keys(factories)) handles[key] = handleOf(key, def.name);
  return {
    name: def.name,
    ...(def.version === undefined ? {} : { version: def.version }),
    needs: def.needs ?? {},
    actions: def.actions ?? [],
    renames: {},
    // Erasure seam: the record is built by key at runtime; its type comes
    // from the factory returns that `plugin()` inferred.
    provides: handles as Handles<TProvides>,
    factories,
    ...(def.logging === undefined ? {} : { logging: def.logging }),
    hooks: {
      ...(def.configure === undefined ? {} : { configure: def.configure }),
      ...(def.boot === undefined ? {} : { boot: def.boot }),
      ...(def.start === undefined ? {} : { start: def.start }),
      ...(def.stop === undefined ? {} : { stop: def.stop }),
      ...(def.dispose === undefined ? {} : { dispose: def.dispose }),
    },
  };
}

/** Rename a plugin's published wire keys — the multi-instance primitive. */
export type RenamedProvides<TP, M> = {
  [K in keyof TP as K extends keyof M ? (M[K] extends string ? M[K] : K) : K]: TP[K];
};

/**
 * Mount-time rename. `rename(dbPlugin, { db: 'reportsDb' }, 'reports-db')`
 * publishes the same service under a different wire key, retyped
 * accordingly — the way to mount a second instance of an adapter without
 * a key collision. Renames compose: renaming an already-renamed key
 * rewrites the earlier entry.
 *
 * The returned plugin's `provides` handles are rebuilt on the new keys and
 * name, so `rename(...).provides.reportsDb` is the handle to reference. A
 * handle taken from the object before the rename keeps the old key — the
 * builder guard reports it missing; reference the handle of the object you
 * mount.
 */
export function rename<
  TN extends ServiceRecord,
  TP extends ServiceRecord,
  const M extends { readonly [K in keyof TP]?: string },
>(p: Plugin<TN, TP>, map: M, newName?: string): Plugin<TN, RenamedProvides<TP, M>> {
  const renames: Record<string, string> = { ...p.renames };
  const entries: Readonly<Record<string, string | undefined>> = map;
  for (const [wireKey, next] of Object.entries(entries)) {
    if (typeof next !== 'string') continue;
    // If `wireKey` is itself the *result* of an earlier rename, rewrite that
    // entry (compose); otherwise it is a local publish key.
    const localKey = Object.entries(renames).find(([, w]) => w === wireKey)?.[0] ?? wireKey;
    renames[localKey] = next;
  }
  const name = newName ?? p.name;
  const handles: Record<string, AnyHandle> = {};
  for (const wireKey of Object.keys(p.provides)) {
    const next = entries[wireKey];
    const key = typeof next === 'string' ? next : wireKey;
    handles[key] = handleOf(key, name);
  }
  // Phantom-only cast: the handles are rebuilt by key at runtime; only the
  // [ProvidesSym] carrier and the handle record retype.
  return { ...p, name, renames, provides: handles } as Plugin<TN, RenamedProvides<TP, M>>;
}

/**
 * Stable error thrown by DOT plugin adapters.
 *
 * Adapters MUST throw `DotPluginError` (not raw `Error`) when surfacing a
 * misconfiguration, missing-input, or other fail-fast condition. Consumers
 * and coding agents can then match on a stable `code`, follow `docsUrl`,
 * and apply `remediation` without parsing the message.
 *
 * Codes are per-adapter. Recommended prefix is `ARKI_<PKG>_PLUGIN_E<NNN>` (e.g.
 * `ARKI_KV_PLUGIN_E001`, `ARKI_DB_PLUGIN_E001`). The kernel does not own the code
 * namespace — each adapter defines its own constants and links them in
 * its README.
 *
 * @see packages/dot/docs/principles.md — principle 1.3 ("errors are part
 * of the API") and principle 4 ("agent-discoverable everywhere").
 */
export class DotPluginError extends Error {
  /** Stable error code, e.g. `ARKI_KV_PLUGIN_E001`. */
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
    this.name = 'DotPluginError';
    this.code = args.code;
    this.remediation = args.remediation;
    this.docsUrl = args.docsUrl;
  }
}

/** Re-exported for downstream typing. */

export { type ActionManifest, type DotAppManifest, type PluginManifest, type ProjectionManifest } from './manifest.js';
