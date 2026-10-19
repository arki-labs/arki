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
 *    throws {@link DotLifecycleError} with code `ARKI_DOT_E001`.
 *  - Declaration order IS boot order. The app builder's type-level guard
 *    makes out-of-order composition a compile error; the kernel re-validates
 *    at configure time from the static `provides` handles.
 *  - `stop` and `dispose` run in reverse declaration order and continue
 *    through individual plugin failures, reporting an aggregate error.
 */

import type { CheckedPlan, ScopeAggregate, ScopeOptions, ScopePlan, SupervisorFailure } from '@arki/async';
import type { Failure, FailureIn, FailureOf, SuccessOf } from '@arki/failure';
import { createLifetime, isScopeEntry } from '@arki/async';
import { isFailure, UnexpectedDefect } from '@arki/failure';

import type { Lazy } from './lazy.js';
import type { ActionManifest, JsonObject, ProjectionManifest, ServiceKind } from './manifest.js';
import { isLazy } from './lazy.js';

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
      return token<T>()(`${key}#${name}`);
    },
  });
}

/**
 * A record holding one value under a token's wire key, typed by the
 * token's literal key: `provide(Db, handle)` is `{ 'arki.db': DbHandle }`.
 */
export function provide<T, K extends string>(tok: Token<T, K>, value: T): Record<K, T> {
  // Safe by construction: the computed key is exactly `tok.key: K`.
  return { [tok.key]: value } as Record<K, T>;
}

/** Record of wire-keyed services. */
export type ServiceRecord = Record<string, unknown>;

export { LazyTag, LazyClosed, lazy, lazyOf, isLazy } from './lazy.js';
export type { Lazy } from './lazy.js';

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
  // The key alone: a handle carries `K` in `key`, `lazy.key` and `instance()`'s `${K}#${N}`; inferring through the
  // whole Token splits a key that holds `#` into two candidates.
  [K in keyof S as S[K] extends { readonly key: infer WK extends string } ? WK : K]: S[K] extends Service<infer T>
    ? T
    : never;
};

/**
 * No `$`-prefixed keys — that prefix is the kernel context namespace
 * ({@link KernelCtx}). Used as a constraint on needs shapes and provides
 * records: a matching key makes the property type `never`, which no
 * witness or service value satisfies, so the violation errors at the
 * exact offending property. The kernel re-validates at runtime with
 * `ARKI_DOT_E014` for paths the constraint cannot see (renames,
 * erased plugins).
 */
export type NoReservedKeys = Readonly<Record<`$${string}`, never>>;

/**
 * Kernel-supplied context keys, present in every service-carrying hook
 * context. The `$` prefix is a reserved namespace: `plugin()` rejects
 * `$`-prefixed needs aliases and publish keys at compile time (via
 * {@link NoReservedKeys}) and the kernel enforces it at runtime
 * (`ARKI_DOT_E014`), so these keys can never be shadowed.
 */
export type KernelCtx = {
  /** App name (passed to `defineApp`). */
  readonly $app: string;
  /** This plugin's name. */
  readonly $plugin: string;
  /** Read-only runtime config bag from `defineApp(name, { config })`. */
  readonly $config: Readonly<Record<string, unknown>>;
  /**
   * Aborts when this hook exceeds `defineApp(name, { hookTimeoutMs })`; the
   * reason is the `ARKI_DOT_E015` error. Pass it to the hook's I/O
   * (`fetch`, a driver's connect, `sleep`) so a hung hook stops instead of
   * running on after the kernel gave up on it. One signal per hook call.
   */
  readonly $signal: AbortSignal;
  /**
   * Complete an action's `summary` once the plugin's services exist (a
   * `provides` factory, `boot`, `start`, ...). `dot explain` stays static;
   * the post-boot `app.manifest` and `dot doctor` show the new text.
   *
   * A plugin may amend an action it declared, or an action in a binding it
   * registered a projection for (an adapter completing the actions of the
   * features it serves). Anything else throws `ARKI_DOT_E021`.
   */
  readonly $describeAction: (actionId: string, patch: { readonly summary: string }) => void;
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
  /**
   * Replace the `summary` of an action already registered. Same ownership
   * rule as `$describeAction` (see {@link KernelCtx}); in `configure` it sees
   * the actions of plugins mounted earlier.
   */
  describeAction(actionId: string, patch: { readonly summary: string }): void;
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

/** Exact failures owned by a plugin's construction and release callbacks. */
export type PluginOwnership = { readonly open: Failure; readonly close: Failure };
export type EmptyOwnership = { readonly open: never; readonly close: never };
type CallbackFailure<Value, Key extends PropertyKey> =
  Value extends Record<Key, infer Callback extends (...args: never[]) => unknown> ? FailureOf<Callback> : never;
type EntriesFailure<Values, Key extends PropertyKey> = {
  [Name in keyof Values]: CallbackFailure<Values[Name], Key>;
}[keyof Values];
/** Consumer-visible successful value of an ordinary or owned provider. */
type ResourceEntry = Extract<ScopePlan[string], { kind: 'resource' }>;
export type ProvidedValue<Value> = Value extends ResourceEntry
  ? Value extends { readonly open: infer Open extends (...args: never[]) => unknown }
    ? SuccessOf<Open>
    : never
  : Exclude<Value, Failure>;
export type ProvidedValues<Values> = { [Name in keyof Values]: ProvidedValue<Awaited<Values[Name]>> };
type ProviderEntries<Values> = { [Name in keyof Values]: Extract<Awaited<Values[Name]>, ResourceEntry> };
type ProviderOpen<Values> =
  Extract<Awaited<Values[keyof Values]>, Failure> | EntriesFailure<ProviderEntries<Values>, 'open'>;
type LazyClose<Value> = Value extends Lazy<unknown, Failure> ? FailureOf<Value['dispose']> : never;
type ProviderClose<Values> =
  | EntriesFailure<ProviderEntries<Values>, 'close'>
  | { [Name in keyof Values]: LazyClose<Exclude<Awaited<Values[Name]>, ResourceEntry | Failure>> }[keyof Values];
export type InferredOwnership<Values, Boot> = {
  readonly open:
    | ProviderOpen<Values>
    | Extract<Boot, Failure>
    | EntriesFailure<Exclude<Boot, void | Failure>, 'open'>
    | EntriesFailure<Exclude<Boot, void | Failure>, 'run'>;
  readonly close:
    | ProviderClose<Values>
    | EntriesFailure<Exclude<Boot, void | Failure>, 'close'>
    | EntriesFailure<Exclude<Boot, void | Failure>, 'run'>;
};
export type PluginOpenFailure<P> = P extends { readonly [OwnershipSym]?: infer Owned extends PluginOwnership }
  ? Owned['open']
  : never;
export type PluginCloseFailure<P> = P extends { readonly [OwnershipSym]?: infer Owned extends PluginOwnership }
  ? Owned['close']
  : never;
export type PluginCloseOutcome<Close extends Failure> =
  void | Close | SupervisorFailure | ScopeAggregate<Close | SupervisorFailure, Close | SupervisorFailure>;
export type PluginBootOutcome<Open extends Failure, Close extends Failure> =
  void | Open | Close | SupervisorFailure | ScopeAggregate<Open | Close | SupervisorFailure, Close | SupervisorFailure>;
/** A successfully constructed plugin lifetime, transferred unchanged to its app. */
export type PluginConstruction<Close extends Failure> = {
  readonly services: ServiceRecord;
  quiesce(): Promise<PluginCloseOutcome<Close>>;
  close(): Promise<PluginCloseOutcome<Close>>;
};
/** Closed operations retain inferred callback outcomes across kernel scheduling. */
export type PluginRuntime<Open extends Failure, Close extends Failure> = {
  construct(
    ctx: never,
    options: ScopeOptions,
    claimLazy: (value: Lazy<unknown, Failure>) => boolean,
  ): Promise<PluginConstruction<Close> | Exclude<PluginBootOutcome<Open, Close>, void>>;
};

/** One factory per published key. Each gets the needs + kernel keys; its key is the publish key. */
type ResourceCallbacks<Value> = Value extends {
  readonly open: (...args: never[]) => unknown;
  readonly close: (...args: never[]) => unknown;
}
  ? { [Key in 'open' | 'close']: Value[Key] extends (...args: never[]) => infer Result ? Awaited<Result> : never }[
      'open' | 'close']
  : unknown;
type CheckedOutput<Value> = [Value] extends [PlainValue]
  ? unknown
  : unknown extends Value
    ? never
    : [Extract<Value, Exclude<ScopePlan[string], ResourceEntry>>] extends [never]
      ? unknown extends ResourceCallbacks<Extract<Value, ResourceEntry>>
        ? never
        : unknown
      : never;

/** Boot plans retain all callback outcomes; erased or untyped plans cannot declare ownership. */
export type BootGuard<Boot extends void | ScopePlan | Failure> = [Exclude<Boot, void | Failure>] extends [
  CheckedPlan<Exclude<Boot, void | Failure>>,
]
  ? []
  : [error: { readonly 'DOT: boot plans must retain typed callback outcomes': Boot }];
/** Plain service objects cannot carry an ownership entry brand or hide an entry in a promise. */
type PlainService = object &
  Readonly<Partial<Record<Extract<keyof ScopePlan[string], symbol>, never>>> & {
    readonly then?: never;
  };
/** Validate each inferred return locally; an arity guard would freeze sibling factories before contextual inference. */
type PlainValue = PlainService | string | number | boolean | bigint | symbol | null | void;
export type CheckedProvider<Value> = PlainValue | PromiseLike<PlainValue> | CheckedOutput<Awaited<Value>>;

/**
 * Infer raw factory returns once, including Promise wrappers. Explicit
 * TProvides annotations describe those raw returns, not the resolved services.
 * Services and ownership resolve promises through their shared projections.
 */
export type ProvidesFactories<TNeeds extends NeedsShape, TProvides extends ServiceRecord> = {
  readonly [K in keyof TProvides]: (
    services: CtxOf<TNeeds> & KernelCtx,
  ) => TProvides[K] & CheckedProvider<NoInfer<TProvides[K]>>;
};

/** An erased factory record — what the kernel runs at boot. */
export type AnyFactories = Readonly<Record<string, (ctx: never) => unknown>>;

declare const NeedsSym: unique symbol;
declare const ProvidesSym: unique symbol;
declare const ProviderIdentitySym: unique symbol;
declare const OwnershipSym: unique symbol;

/**
 * The DOT plugin (v2). Author through {@link plugin} — never construct directly.
 *
 * Hook signatures are type-erased here (`ctx: never`): the typed view
 * lives on `plugin()`'s parameter, and `(ctx: Typed) => R` is assignable to
 * `(ctx: never) => R` without casts (parameter contravariance from the
 * bottom type). The kernel crosses the erasure boundary at the call site.
 *
 * The phantom symbol properties carry `TNeeds` / `TProvides` for the app
 * builder's compile-time wiring check, and `TShape` (the `needs` record as
 * written: alias → witness) so the feature builder can read WHICH handle a
 * need names — its `provider` and `key` literals — not only the service type.
 * `Plugin<N, P>` without a shape means "unknown"; the checks that read it
 * fall back to the wire-key rules. They never exist at runtime. `TOwner` is
 * the plugin's name as a literal — the `provider` its handles carry.
 */
/** See {@link Plugin.role}. */
export type DotPluginRole = 'feature' | 'driving';

export type Plugin<
  TNeeds extends ServiceRecord = ServiceRecord,
  TProvides extends ServiceRecord = ServiceRecord,
  TShape extends NeedsShape = NeedsShape,
  TOwner extends string = string,
  TOwnership extends PluginOwnership = EmptyOwnership,
> = {
  readonly runtime: PluginRuntime<TOwnership['open'], TOwnership['close']>;
  readonly [OwnershipSym]?: TOwnership;
  /** Unique identifier for this plugin within the app. */
  readonly name: string;
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
  readonly provides: Handles<TProvides, TOwner>;
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
    readonly boot?: (ctx: never) => unknown;
    readonly start?: (ctx: never) => MaybePromise<void>;
    readonly stop?: (ctx: never) => MaybePromise<void>;
    readonly dispose?: (ctx: never) => MaybePromise<void>;
  };
  readonly [NeedsSym]?: TNeeds;
  readonly [ProvidesSym]?: TProvides;
  readonly [ProviderIdentitySym]?: TShape;
};

/** Extract a plugin's (wire-keyed) needs record. */
export type PluginNeeds<P> = P extends Plugin<infer N, ServiceRecord, NeedsShape, string, PluginOwnership> ? N : never;
/** Extract a plugin's (wire-keyed) provides record. */
export type PluginProvides<P> =
  P extends Plugin<ServiceRecord, infer Pr, NeedsShape, string, PluginOwnership> ? Pr : never;
/**
 * Extract a plugin's needs as written (alias → witness). A handle witness
 * carries the identity of the service it names (`provider` + `key`); an
 * anonymous `service<T>()` carries none. `NeedsShape` (every key, every
 * witness) when the plugin was typed without a shape — "unknown".
 */
export type PluginProviderIdentities<P> =
  P extends Plugin<ServiceRecord, ServiceRecord, infer S, string, PluginOwnership> ? S : NeedsShape;
/** The `provider` literal a plugin's handles carry (`string` when the plugin was typed without its name). */
export type PluginOwner<P> =
  P extends Plugin<ServiceRecord, ServiceRecord, NeedsShape, infer O, PluginOwnership> ? O : string;

/** Internal type alias used by the kernel to erase plugin service generics. */
export type AnyPlugin = Plugin<ServiceRecord, ServiceRecord, NeedsShape, string, PluginOwnership>;
/** A scheduled plugin whose closed execution operations retain exact phase outcomes. */
export type RuntimePlugin<Open extends Failure, Close extends Failure> = Omit<AnyPlugin, 'runtime'> & {
  readonly runtime: PluginRuntime<Open, Close>;
};

/**
 * Author a DOT plugin.
 *
 * - `TShape` is inferred from the `needs` object literal.
 * - `TProvides` is inferred from the raw `provides` factory returns, including
 *   Promise wrappers — no generic argument. Each factory gets the needs
 *   (under their local aliases) plus
 *   the `$`-prefixed kernel keys; it may be async. The kernel runs them in
 *   key order at boot.
 * - `boot` runs after the factories and sees their successful values. It may
 *   return a typed private ownership plan or a business failure. Publish
 *   services through `provides`.
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
export type PluginDefinition<
  TShape extends NeedsShape,
  TProvides extends ServiceRecord,
  TName extends string,
  TBoot,
> = {
  readonly name: TName;
  readonly needs?: TShape;
  readonly actions?: readonly ActionSource[];
  /** Fill the logging slot (see {@link Plugin.logging}). Called by the kernel, never at import. */
  readonly logging?: (ctx: DotLoggingContext) => DotLoggingHandle;
  readonly configure?: (ctx: DotConfigureContext) => void;
  /** One factory per published key. Each gets the needs + kernel keys. Keys are the publish keys. */
  readonly provides?: ProvidesFactories<TShape, TProvides>;
  /** Runs after the factories; may return a typed private ownership plan or failure. */
  readonly boot?: (ctx: CtxOf<TShape> & ProvidedValues<TProvides> & KernelCtx) => MaybePromise<TBoot>;
  readonly start?: (ctx: CtxOf<TShape> & ProvidedValues<TProvides> & KernelCtx) => MaybePromise<void>;
  readonly stop?: (ctx: CtxOf<TShape> & ProvidedValues<TProvides> & KernelCtx) => MaybePromise<void>;
  readonly dispose?: (ctx: CtxOf<TShape> & ProvidedValues<TProvides> & KernelCtx) => MaybePromise<void>;
};

export function plugin<
  TShape extends NeedsShape & NoReservedKeys = EmptyShape,
  TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
  const TName extends string = string,
  TBoot extends void | ScopePlan | Failure = void,
>(
  def: PluginDefinition<TShape, TProvides, TName, TBoot>,
  ..._guard: BootGuard<NoInfer<TBoot>>
): Plugin<WireNeeds<TShape>, ProvidedValues<TProvides>, TShape, TName, InferredOwnership<TProvides, Awaited<TBoot>>> {
  return createPlugin(def);
}

/** Shared constructor after each authoring surface has checked its provider returns. */
export function createPlugin<
  TShape extends NeedsShape & NoReservedKeys,
  TProvides extends ServiceRecord & NoReservedKeys,
  const TName extends string,
  TBoot extends void | ScopePlan | Failure,
>(
  def: PluginDefinition<TShape, TProvides, TName, TBoot>,
): Plugin<WireNeeds<TShape>, ProvidedValues<TProvides>, TShape, TName, InferredOwnership<TProvides, Awaited<TBoot>>> {
  const factories: AnyFactories = def.provides ?? {};
  const handles: Record<string, AnyHandle> = {};
  for (const key of Object.keys(factories)) handles[key] = handleOf(key, def.name);
  return {
    name: def.name,
    needs: def.needs ?? {},
    actions: def.actions ?? [],
    renames: {},
    // Erasure seam: the record is built by key at runtime; its type comes
    // from the factory returns that `plugin()` inferred, its `provider` from `name`.
    provides: handles as Handles<ProvidedValues<TProvides>, TName>,
    runtime: createPluginRuntime<TProvides, TBoot>(def.provides, def.boot),
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

function failed<Value>(value: Value): value is FailureIn<Value> {
  return isFailure<unknown>(value);
}

export function createPluginRuntime<Values, Boot>(
  factories: { readonly [Name in keyof Values]: (ctx: never) => MaybePromise<Values[Name]> } | undefined,
  boot?: (ctx: never) => MaybePromise<Boot>,
  project?: (services: ServiceRecord, ctx: never) => void,
): PluginRuntime<InferredOwnership<Values, Awaited<Boot>>['open'], InferredOwnership<Values, Awaited<Boot>>['close']>;
export function createPluginRuntime(
  factories: AnyFactories | undefined,
  boot?: (ctx: never) => unknown,
  project?: (services: ServiceRecord, ctx: never) => void,
): PluginRuntime<Failure, Failure> {
  return {
    async construct(ctx: Record<string, unknown>, options, claimLazy) {
      const lifetime = createLifetime<Failure, Failure>(options);
      const normalize = async (run: () => unknown) => {
        try {
          const result = await run();
          if (failed(result)) return result;
        } catch (error) {
          return UnexpectedDefect({ cause: error });
        }
        return;
      };
      const acquire = (prepare: Extract<ScopePlan[string], { kind: 'resource' }>['prepare']) => {
        const run = async (signal: AbortSignal) => {
          const prepared = await prepare(signal);
          if (failed(prepared)) return prepared;
          return { value: prepared.value, close: () => normalize(prepared.close) };
        };
        return lifetime.acquire<typeof run>(run);
      };
      const services: ServiceRecord = {};
      const context: Record<string, unknown> = { ...ctx, $signal: lifetime.signal };
      try {
        for (const [key, factory] of Object.entries(factories ?? {})) {
          if (lifetime.signal.aborted) break;
          // Admit the factory before it runs so shutdown also owns a late Lazy.
          const prepareFactory = async () => {
            const provided = await factory(context as never);
            if (failed(provided)) return provided;
            const ownedLazy = isLazy(provided) && claimLazy(provided) ? provided : undefined;
            return { value: provided, close: () => normalize(() => ownedLazy?.dispose()) };
          };
          const provided = await lifetime.acquire(prepareFactory);
          if (failed(provided)) {
            lifetime.fail(provided);
            break;
          }
          const value =
            isScopeEntry(provided) && provided.kind === 'resource' ? await acquire(provided.prepare) : provided;
          if (failed(value)) {
            lifetime.fail(value);
            break;
          }
          services[key] = value;
        }
        if (!lifetime.signal.aborted && !lifetime.hasFailure()) project?.(services, context as never);
        if (!lifetime.signal.aborted && !lifetime.hasFailure() && boot !== undefined) {
          const result = await boot({ ...context, ...services } as never);
          if (failed(result)) lifetime.fail(result);
          else if (result !== undefined) {
            if (typeof result !== 'object' || result === null) lifetime.fail(UnexpectedDefect({ cause: result }));
            else
              for (const value of Object.values(result)) {
                if (!isScopeEntry(value)) {
                  lifetime.fail(UnexpectedDefect({ cause: result }));
                  break;
                }
                if (value.kind === 'resource') {
                  const opened = await acquire(value.prepare);
                  if (failed(opened)) {
                    lifetime.fail(opened);
                    break;
                  }
                } else if (value.kind === 'cleanup') lifetime.defer(() => normalize(value.close));
                else {
                  const run = async (signal: AbortSignal) => {
                    const result = await value.run(signal);
                    if (failed(result)) return result;
                    return;
                  };
                  lifetime.fork(run);
                }
              }
          }
        }
      } catch (error) {
        const defect = lifetime.defect(error);
        if (defect !== undefined) lifetime.fail(defect);
      }
      if (lifetime.signal.aborted || lifetime.hasFailure()) {
        const closed = await lifetime.close();
        return failed(closed) ? closed : UnexpectedDefect({ cause: new Error('Plugin construction lost its failure') });
      }
      return { services, quiesce: lifetime.quiesce, close: lifetime.close };
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
 * mount. Without `newName` the handles keep the original provider.
 */
export function rename<
  P extends AnyPlugin,
  TOwnership extends PluginOwnership,
  const M extends { readonly [K in keyof PluginProvides<P>]?: string },
  const TNewName extends string = PluginOwner<P>,
>(
  p: P & {
    readonly runtime: PluginRuntime<TOwnership['open'], TOwnership['close']>;
    readonly [OwnershipSym]?: TOwnership;
  },
  map: M,
  newName?: TNewName,
): Plugin<PluginNeeds<P>, RenamedProvides<PluginProvides<P>, M>, PluginProviderIdentities<P>, TNewName, TOwnership> {
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
  // Only rebuilt wire handles need the existing service-shape assertion;
  // the source runtime operation retains its checked ownership parameters.
  const metadata: Omit<
    AnyPlugin,
    typeof NeedsSym | typeof ProvidesSym | typeof ProviderIdentitySym | typeof OwnershipSym
  > = p;
  return {
    ...metadata,
    name,
    renames,
    provides: handles as Handles<RenamedProvides<PluginProvides<P>, M>, TNewName>,
    runtime: p.runtime,
  };
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
