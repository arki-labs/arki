/**
 * `@arki/dot/feature` — domain modules for DOT apps.
 *
 * A feature is a named, inert declaration of what one domain module
 * contributes to an app:
 *
 * - `router` / `repos` — compile-time fragments. Fold them with
 *   `composeRouter` / `composeRepos` from one membership list; no
 *   kernel is involved, so tests and plain scripts consume them
 *   directly.
 * - `use` — boot-time slices (jobs, schedules, HTTP routes) declared
 *   through slice contracts exported by the adapter that consumes them
 *   (e.g. `jobs()` from `@arki/queue/dot`). Each contract carries its
 *   payload plus the manifest actions derived from it, so this module
 *   depends on no adapter and the slice set stays open.
 * - `needs` / `provides` / `boot` — the runtime escape hatch for genuine
 *   lifecycle (an auth instance, an event store). `provides` holds one
 *   factory per capability; its keys are static, so the graph is data
 *   before anything boots. `boot` is side effects only (seed, warm-up).
 *   Most features never use any of them.
 *
 * The app mounts features in the middle phase of the hexagon:
 *
 *   defineApp(name)
 *     .use(...)        driven adapters: what features need (db, kv, queue client)
 *     .features([...]) the domain core
 *     .serve(...)      driving adapters: what calls the features (http, workers)
 *
 * `.features()` turns each feature into a plugin; driving adapters are
 * `driver(...)` values that `.serve()` binds to the mounted feature list.
 */
import type {
  ActionSource,
  AnyFactories,
  AnyHandle,
  AnyPlugin,
  CtxOf,
  EmptyShape,
  Handles,
  KernelCtx,
  NeedsShape,
  NoReservedKeys,
  Plugin,
  ProvidesFactories,
  Service,
  ServiceRecord,
  Token,
  WireNeeds,
} from './plugin-contract.js';
import { FEATURE_ERROR_CODES, FeatureError } from './feature-error.js';
import { handleOf, isLazy, isLazyWitness, lazyOf, plugin, token } from './plugin-contract.js';

export { FEATURE_ERROR_CODES, FeatureError } from './feature-error.js';
export type { FeatureErrorCode } from './feature-error.js';

// The chain form (`defineFeature(name).needs().infra().usecases().provides().entrypoints()`)
// and contract-first composition (`routerFor`). See RFC 2026-10-15-dot-feature-builder.
export { defineFeature, routerFor } from './define-feature.js';
export type {
  AnyDefinedFeature,
  AnyEntrypoint,
  AnyFeatureCore,
  AppContract,
  ContractOf,
  CoreDeps,
  CoreHandles,
  CoreServices,
  DefinedFeature,
  DepsOf,
  Entrypoint,
  EntrypointPayloads,
  EntrypointsStage,
  FeatureCore,
  FeatureUnit,
  InfraProvides,
  InfraStage,
  NeedsStage,
  ProvidesStage,
  QualifiedInfra,
  QualifiedPlugin,
  ReservedAlias,
  RouterFor,
  RouterOf,
  RpcEntrypoint,
  UsecasesStage,
} from './define-feature.js';

export type { Handle, Handles, LazyHandle, Provided, ProvidesFactories } from './plugin-contract.js';

export type MaybePromise<T> = T | Promise<T>;

export type RouterFragments = Record<string, unknown>;
export type RepoFactories = Record<string, (database: never) => unknown>;

/**
 * A boot-time slice contract. Adapter packages export factories that
 * produce these (`jobs()`, `schedules()`, `endpoints()`): the payload
 * lands under `key` in the feature's published slice record, and the
 * `actions` derived from the payload join the feature's manifest. The
 * shape is structural on purpose — an adapter can mint slices without
 * importing this module.
 */
export type FeatureSlice<K extends string = string, P = unknown, TServices = never> = {
  readonly key: K;
  readonly actions: readonly ActionSource[];
  readonly resolve: (services: TServices) => P;
};

export type AnyFeatureSlice = FeatureSlice<string, unknown, never>;

type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer I) => void
  ? I
  : never;

/** The slice record a feature's `use` tuple publishes, keyed by slice key. */
export type SlicePayloads<TUse extends readonly AnyFeatureSlice[]> = TUse extends readonly []
  ? EmptyShape
  : UnionToIntersection<
      {
        [I in keyof TUse]: TUse[I] extends FeatureSlice<infer K, infer P, never> ? Readonly<Record<K, P>> : never;
      }[number]
    >;

export type Feature<
  TName extends string = string,
  TNeeds extends NeedsShape = NeedsShape,
  TProvides extends ServiceRecord = ServiceRecord,
  TUse extends readonly AnyFeatureSlice[] = readonly AnyFeatureSlice[],
  TRouter extends RouterFragments = RouterFragments,
  TRepos extends RepoFactories = RepoFactories,
> = {
  readonly name: TName;
  /** Compile-time fragments, folded by `composeRouter` / `composeRepos`. */
  readonly router: TRouter;
  readonly repos: TRepos;
  /** Boot-time slice contracts + static manifest actions. */
  readonly use: TUse;
  readonly actions: readonly ActionSource[];
  /** Runtime escape hatch — becomes the plugin lifecycle in `.features()`. */
  readonly needs: TNeeds;
  /** One factory per capability, run in key order when the feature boots. */
  readonly factories: ProvidesFactories<TNeeds, TProvides>;
  /** Side effects only (seed, warm-up). Runs after the factories and sees their values. */
  readonly boot?: (services: CtxOf<TNeeds> & TProvides & KernelCtx) => MaybePromise<void>;
  /**
   * Typed handles for what the feature provides: `billing.provides.entitlements`
   * is a `Token` on the same wire key, typed from billing's factory and
   * stamped with the providing feature. A consumer names the capability in
   * its `needs` and never restates the type — the Drizzle
   * `references(() => table.column)` of features. The keys are static, so
   * `Object.keys(billing.provides)` is known before anything boots.
   */
  readonly provides: Handles<TProvides, TName>;
};

/**
 * The erased feature bound list helpers fold over. `boot`'s parameter
 * is `never` (the contravariant top) so features with concrete `needs`
 * remain assignable — same trick as `RepoFactories`' `(database: never)`.
 */
export type AnyFeature = {
  readonly name: string;
  readonly router: RouterFragments;
  readonly repos: RepoFactories;
  readonly use: readonly AnyFeatureSlice[];
  readonly actions: readonly ActionSource[];
  readonly needs: NeedsShape;
  readonly factories: Readonly<Record<string, (services: never) => unknown>>;
  readonly boot?: (services: never) => MaybePromise<void>;
  readonly provides: Readonly<Record<string, AnyHandle>>;
};

/**
 * Declare a feature. Pure data capture — nothing executes here; the app
 * builder's `.features()` turns it into a plugin.
 */
export function feature<
  const TName extends string,
  TNeeds extends NeedsShape & NoReservedKeys = EmptyShape,
  TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
  const TUse extends readonly FeatureSlice<string, unknown, CtxOf<TNeeds> & KernelCtx>[] = readonly [],
  const TRouter extends RouterFragments = EmptyShape,
  const TRepos extends RepoFactories = EmptyShape,
>(
  name: TName,
  config: {
    /** oRPC router fragment(s), keyed by mount name. */
    readonly router?: TRouter;
    /** Repository factories, keyed by their `ctx.repo` name. */
    readonly repos?: TRepos;
    /** Boot-time slice contracts (`jobs(...)`, `schedules(...)`, `endpoints(...)`). */
    readonly use?: TUse;
    /** Extra static manifest actions (e.g. route contracts). */
    readonly actions?: readonly ActionSource[];
    readonly needs?: TNeeds;
    /** One factory per capability. Each gets the feature's needs. Keys are the wire keys. */
    readonly provides?: ProvidesFactories<TNeeds, TProvides>;
    /** Side effects only (seed, warm-up). Runs after the factories and sees their values. */
    readonly boot?: (services: CtxOf<TNeeds> & TProvides & KernelCtx) => MaybePromise<void>;
  },
): Feature<TName, TNeeds, TProvides, TUse, TRouter, TRepos> {
  const sliceKeys = new Set<string>();
  for (const slice of config.use ?? []) {
    // A second slice under one key would silently replace the first once the
    // feature is mounted (the payload record is keyed by slice key).
    if (sliceKeys.has(slice.key)) {
      throw new FeatureError({
        code: FEATURE_ERROR_CODES.duplicateSliceKey,
        message: `[feature] feature "${name}" declares two "${slice.key}" slices in \`use\`; the second would silently replace the first.`,
        remediation: `Move one of the "${slice.key}" slices into its own feature, or merge them into one slice.`,
      });
    }
    sliceKeys.add(slice.key);
  }
  const factories = config.provides ?? ({} as ProvidesFactories<TNeeds, TProvides>);
  const handles: Record<string, AnyHandle> = {};
  for (const key of Object.keys(factories)) {
    handles[key] = handleOf(key, name);
  }
  return {
    name,
    router: (config.router ?? {}) as TRouter,
    repos: (config.repos ?? {}) as TRepos,
    use: (config.use ?? []) as unknown as TUse,
    actions: config.actions ?? [],
    needs: (config.needs ?? {}) as TNeeds,
    factories,
    boot: config.boot,
    // Erasure seam: the record is built by key at runtime; its type comes
    // from the factory returns that `feature()` inferred.
    provides: handles as Feature<TName, TNeeds, TProvides>['provides'],
  };
}

/* ------------------------------------------------------------------ */
/* Static folds                                                        */
/* ------------------------------------------------------------------ */

/** The keys a record names one by one. An index signature (`Record<string, X>`) names none. */
type LiteralKeys<R> = keyof {
  [K in keyof R as string extends K ? never : number extends K ? never : symbol extends K ? never : K]: R[K];
};

/** Keys that more than one record in the tuple names. `never` when every key is unique. */
type DuplicateKeys<TRecords extends readonly unknown[], TSeen extends PropertyKey = never> = TRecords extends readonly [
  infer Head,
  ...infer Tail,
]
  ? (LiteralKeys<Head> & TSeen) | DuplicateKeys<Tail, TSeen | LiteralKeys<Head>>
  : never;

type RoutersOf<T extends readonly AnyFeature[]> = {
  readonly [I in keyof T]: T[I] extends AnyFeature ? T[I]['router'] : never;
};

type ReposOf<T extends readonly AnyFeature[]> = {
  readonly [I in keyof T]: T[I] extends AnyFeature ? T[I]['repos'] : never;
};

/**
 * `unknown` when no key repeats. Otherwise a property the feature list
 * cannot have, so the call does not compile and the error names the keys.
 */
type Distinct<TKeys extends PropertyKey, TLabel extends string> = [TKeys] extends [never]
  ? unknown
  : Readonly<Record<TLabel, TKeys>>;

export type ComposedRouter<T extends readonly AnyFeature[]> = UnionToIntersection<T[number]['router']>;

/**
 * Fold the features' router fragments into one router — value AND type
 * from the single list. A mount key claimed by two features is a compile
 * error, and throws `FeatureError` at module load for code that skips types.
 */
export function composeRouter<const T extends readonly AnyFeature[]>(
  features: T & NoInfer<Distinct<DuplicateKeys<RoutersOf<T>>, 'ARKI_FEATURE: duplicate router mount keys'>>,
): ComposedRouter<T> {
  const merged: Record<string, unknown> = {};
  for (const f of features) {
    for (const [key, fragment] of Object.entries(f.router)) {
      if (key in merged) {
        throw new FeatureError({
          code: FEATURE_ERROR_CODES.duplicateRouterKey,
          message: `[feature] router mount key "${key}" is contributed by more than one feature.`,
          remediation: 'Give each feature its own router mount key, or merge the two fragments in one feature.',
        });
      }
      merged[key] = fragment;
    }
  }
  return merged as ComposedRouter<T>;
}

type MergedRepoFactories<T extends readonly AnyFeature[]> = UnionToIntersection<T[number]['repos']>;

/**
 * The repo record a feature tuple composes. An app's `AppRepo` should
 * be pinned to this in a type test one module away from its `Context`
 * (referencing it directly from `Context` closes a circular type loop
 * through the router fragments).
 */
export type ComposedRepos<T extends readonly AnyFeature[]> = {
  readonly [K in keyof MergedRepoFactories<T>]: MergedRepoFactories<T>[K] extends (database: never) => infer R
    ? R
    : never;
};

type RepoFactoryOf<F extends AnyFeature> = F['repos'][keyof F['repos']];

type RepoDbParamOf<F extends AnyFeature> = [RepoFactoryOf<F>] extends [never]
  ? unknown
  : RepoFactoryOf<F> extends (database: infer D) => unknown
    ? D
    : unknown;

/**
 * The db handle type every repo factory in the tuple accepts —
 * intersected ACROSS features via signature-parameter inference rather
 * than a distributive UnionToIntersection, so a factory whose param is
 * itself a union (`Db | Transaction`) keeps it intact instead of
 * collapsing to `Db & Transaction`. Repo-less features contribute
 * `unknown` (the intersection identity).
 */
export type RepoDatabaseOf<T extends readonly AnyFeature[]> = {
  [I in keyof T]: (database: RepoDbParamOf<T[I]>) => void;
}[number] extends (database: infer TDb) => void
  ? TDb
  : never;

/**
 * Fold the features' repo factories over one db handle. A repo key claimed
 * by two features is a compile error, and throws `FeatureError` for code
 * that skips types.
 */
export function composeRepos<const T extends readonly AnyFeature[]>(
  features: T & NoInfer<Distinct<DuplicateKeys<ReposOf<T>>, 'ARKI_FEATURE: duplicate repo keys'>>,
  database: RepoDatabaseOf<T>,
): ComposedRepos<T> {
  const repos: Record<string, unknown> = {};
  for (const f of features) {
    for (const [key, factory] of Object.entries(f.repos)) {
      if (key in repos) {
        throw new FeatureError({
          code: FEATURE_ERROR_CODES.duplicateRepoKey,
          message: `[feature] repo key "${key}" is contributed by more than one feature.`,
          remediation: 'Give each feature its own repo key, or move both factories into one feature.',
        });
      }
      repos[key] = (factory as (db: RepoDatabaseOf<T>) => unknown)(database);
    }
  }
  return repos as ComposedRepos<T>;
}

/* ------------------------------------------------------------------ */
/* Kernel projection                                                   */
/* ------------------------------------------------------------------ */

export type FeatureTokenOf<F extends AnyFeature> = Token<SlicePayloads<F['use']>, `feature.${F['name']}`>;

/**
 * The service values a feature provides, keyed by wire key — each handle
 * unwrapped to its value type. Distributive over `F`, so a union of
 * features maps member by member (a mapped type over the union would keep
 * only the keys every member shares).
 */
export type ProvidedOf<F extends HasProvides> = F extends HasProvides
  ? { [K in keyof F['provides']]: F['provides'][K] extends Service<infer T> ? T : never }
  : never;

/**
 * The plugin a feature becomes inside `.features()`. `WireNeeds` unwraps
 * the witness record to value types — the builder guard compares
 * availability against values, exactly as `plugin()` returns.
 */
export type PluginOf<F extends AnyFeature> = Plugin<
  WireNeeds<F['needs']>,
  ProvidedOf<F> & Readonly<Record<`feature.${F['name']}`, SlicePayloads<F['use']>>>
>;

/** Tuple map from features to the plugins `.features()` mounts. */
export type PluginsOf<T extends readonly AnyFeature[]> = {
  readonly [I in keyof T]: T[I] extends AnyFeature ? PluginOf<T[I]> : never;
};

/**
 * The slice token a feature publishes. Driving adapters list these as
 * runtime needs so the kernel hands them each feature's slice record.
 */
export function tokenOf<F extends AnyFeature>(f: F): FeatureTokenOf<F> {
  return token<SlicePayloads<F['use']>>()(`feature.${f.name}` as `feature.${F['name']}`);
}

/**
 * Compile one feature into the kernel unit the app mounts. Called by
 * `.features()`. The feature's factories run as the plugin's factories, and
 * its slice record is one more provides entry under `feature.<name>`, so
 * `boot` stays side effects only. The feature's own handles pass through
 * unchanged: `billing.provides.x === plug(billing).provides.x`.
 */
export function plug<F extends AnyFeature>(f: F): PluginOf<F> {
  const sliceKey = tokenOf(f).key;
  const actions: ActionSource[] = [...f.actions, ...f.use.flatMap(slice => slice.actions)];
  const slices = (ctx: CtxOf<NeedsShape> & KernelCtx): Readonly<Record<string, unknown>> => {
    const payloads: Record<string, unknown> = {};
    for (const slice of f.use) {
      // Erasure seam: each slice was typed against this feature's needs by
      // feature(); the kernel built `ctx` from those same needs.
      payloads[slice.key] = (slice.resolve as (services: unknown) => unknown)(ctx);
    }
    return payloads;
  };
  const factories: AnyFactories = { ...f.factories, [sliceKey]: slices };

  // Factory seam: plugin()'s inference through the erased factory record is
  // re-typed to the true shape below. feature()'s signature already enforced
  // NoReservedKeys on the caller's needs and provides.
  const unit = plugin({
    name: f.name,
    actions,
    needs: f.needs as NeedsShape & NoReservedKeys,
    provides: factories as ProvidesFactories<NeedsShape, ServiceRecord & NoReservedKeys>,
    ...(f.boot === undefined
      ? {}
      : { boot: f.boot as (services: CtxOf<NeedsShape> & ServiceRecord & KernelCtx) => MaybePromise<void> }),
  });
  return { ...unit, provides: { ...f.provides, [sliceKey]: handleOf(sliceKey, f.name) } } as unknown as PluginOf<F>;
}

/* ------------------------------------------------------------------ */
/* Capabilities in the request context                                 */
/* ------------------------------------------------------------------ */

/**
 * The services a request context carries: wire key → value. Opaque on
 * purpose — naming the merged type in the context closes a type loop
 * through the routers. Procedures narrow it with their feature's own
 * `needs` through {@link resolveNeeds}.
 */
export type ServicesBag = Readonly<Record<string, unknown>>;

/** Anything with static handles — a feature or a plugin. */
export type HasProvides = { readonly provides: Readonly<Record<string, AnyHandle>> };

/** Every handle the units in the tuple provide, merged into one record. */
export type HandlesIn<T extends readonly HasProvides[]> = UnionToIntersection<T[number]['provides']>;

/** Every service value the units (features or plugins) in the tuple provide, keyed by wire key. */
export type ServicesOf<T extends readonly HasProvides[]> = UnionToIntersection<ProvidedOf<T[number]>>;

/** The entries of a needs shape that are capability handles (driven services like `db` drop out). */
export type HandleEntries<N extends NeedsShape> = {
  [K in keyof N as N[K] extends { readonly provider: string } ? K : never]: N[K];
};

function isHandle(witness: object): witness is AnyHandle {
  return 'provider' in witness && typeof witness.provider === 'string' && 'key' in witness && typeof witness.key === 'string';
}

/**
 * Every handle the features (and plugins) provide, merged — spread it into
 * a gateway feature's `needs` and the kernel hands it every capability:
 * `providesOf([database, cache, ...features])`. The builder guard then
 * proves the gateway is mounted after every provider.
 */
export function providesOf<const T extends readonly HasProvides[]>(units: T): HandlesIn<T> {
  const merged: Record<string, AnyHandle> = {};
  for (const unit of units) Object.assign(merged, unit.provides);
  // Erasure seam: the merge is built by key at runtime; its type is the
  // intersection of the features' handle records.
  return merged as HandlesIn<T>;
}

function missingCapability(alias: string, handle: AnyHandle, where: string, remediation: string): FeatureError {
  return new FeatureError({
    code: FEATURE_ERROR_CODES.missingCapability,
    message: `[feature] "${alias}" (capability "${handle.key}" from feature "${handle.provider}") is not in ${where}.`,
    remediation,
  });
}

/**
 * Read every capability the units (features, `defineFeature` features or plugins) provide out of a hook context whose
 * `needs` spread {@link providesOf} — the bag a gateway passes to its
 * request context.
 */
export function servicesOf<const T extends readonly HasProvides[]>(ctx: object, features: T): ServicesOf<T> {
  const source = ctx as Readonly<Record<string, unknown>>;
  const bag: Record<string, unknown> = {};
  for (const f of features) {
    for (const [key, handle] of Object.entries(f.provides)) {
      if (!(key in source)) {
        throw missingCapability(
          key,
          handle,
          "this hook's context",
          "Spread providesOf(features) into this feature's needs, so the kernel hands it every capability.",
        );
      }
      bag[key] = source[key];
    }
  }
  // Erasure seam: the bag is built by key at runtime; its type is the
  // merge of the features' provided values.
  return bag as ServicesOf<T>;
}

/**
 * Narrow a request context's services bag with a feature's own `needs`:
 * each capability handle resolves to its value under the local alias.
 * Driven services (`db`) are not in the bag and drop out of the result.
 *
 * @throws {FeatureError} `FEATURE_E005` when a handle's key is not in the bag.
 */
export function resolveNeeds<N extends NeedsShape>(bag: ServicesBag, needs: N): CtxOf<HandleEntries<N>> {
  const resolved: Record<string, unknown> = {};
  for (const [alias, witness] of Object.entries(needs)) {
    if (!isHandle(witness)) continue;
    if (!(witness.key in bag)) {
      throw missingCapability(
        alias,
        witness,
        "the request context's services bag",
        "Spread providesOf(features) into the gateway's needs and pass servicesOf(ctx, features) to createContext.",
      );
    }
    const value = bag[witness.key];
    // A lazy handle (`handle.lazy`) always receives a `Lazy<T>`, as in hook contexts.
    resolved[alias] = isLazyWitness(witness) && !isLazy(value) ? lazyOf(value) : value;
  }
  // Erasure seam: resolved by alias at runtime from the handles' wire keys.
  return resolved as CtxOf<HandleEntries<N>>;
}

/* ------------------------------------------------------------------ */
/* Driving adapters                                                    */
/* ------------------------------------------------------------------ */

/**
 * A driving adapter: something that calls INTO the features (an HTTP
 * server, a job worker, a scheduler). `.serve()` binds it to the features
 * the app mounted, so app code never lists them twice.
 *
 * `TNeeds` / `TProvides` are the adapter's own wiring, checked by the
 * builder guard like any plugin. `.serve()` adds each feature's slice
 * token to the bound plugin's runtime needs — always satisfied, because
 * `.serve()` only exists after `.features()` — and the adapter reads the
 * records with {@link sliceOf}.
 */
export type Driver<TNeeds extends ServiceRecord = ServiceRecord, TProvides extends ServiceRecord = ServiceRecord> = {
  readonly side: 'driving';
  readonly bind: (features: readonly AnyFeature[]) => Plugin<TNeeds, TProvides>;
};

/** Author a driving adapter. `bind` receives the app's mounted features, in order. */
export function driver<TNeeds extends ServiceRecord, TProvides extends ServiceRecord>(
  bind: (features: readonly AnyFeature[]) => Plugin<TNeeds, TProvides>,
): Driver<TNeeds, TProvides> {
  return { side: 'driving', bind };
}

/**
 * A driven adapter that reads the features' static declarations — e.g. the
 * journal composing every feature's `journalHandlers` slice so features can
 * write through it. `.use()` binds it when the app is built, to the final
 * feature list, and it boots BEFORE the features: it sees only their
 * declarations (`f.use` slice objects), never slice records —
 * {@link sliceOf} throws there.
 */
export type Driven<TNeeds extends ServiceRecord = ServiceRecord, TProvides extends ServiceRecord = ServiceRecord> = {
  readonly side: 'driven';
  readonly bind: (features: readonly AnyFeature[]) => Plugin<TNeeds, TProvides>;
};

/** Author a driven adapter that reads the features' declarations. */
export function driven<TNeeds extends ServiceRecord, TProvides extends ServiceRecord>(
  bind: (features: readonly AnyFeature[]) => Plugin<TNeeds, TProvides>,
): Driven<TNeeds, TProvides> {
  return { side: 'driven', bind };
}

/**
 * Bind a driver and add the features' slice tokens to its runtime needs,
 * so the kernel hands it every slice record and `dot explain` draws the
 * feature → driver edges. Called by `.serve()`.
 */
export function bindDriver(adapter: Driver, features: readonly AnyFeature[]): AnyPlugin {
  const bound = adapter.bind(features) as AnyPlugin;
  const sliceNeeds = Object.fromEntries(features.map(f => [tokenOf(f).key, tokenOf(f)]));
  return { ...bound, needs: { ...sliceNeeds, ...bound.needs } };
}

/**
 * The slice record one feature published — read inside a bound driver's
 * hooks. Values are untyped on purpose: the adapter that minted the slice
 * checks its own payload shape (`jobs()`, `schedules()`, `endpoints()`).
 */
export function sliceOf(ctx: object, f: AnyFeature): Readonly<Record<string, unknown>> {
  const key = tokenOf(f).key;
  const record: unknown = (ctx as Readonly<Record<string, unknown>>)[key];
  if (typeof record !== 'object' || record === null) {
    throw new FeatureError({
      code: FEATURE_ERROR_CODES.missingSlices,
      message: `[feature] the slice record of feature "${f.name}" is not in this hook's context.`,
      remediation: 'Mount the adapter with `.serve(adapter)` after `.features([...])`, so it is bound to the features.',
    });
  }
  return record as Readonly<Record<string, unknown>>;
}
