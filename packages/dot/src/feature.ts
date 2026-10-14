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
 * - `needs` / `boot` — the runtime escape hatch for genuine lifecycle
 *   (an auth instance, an event store). Most features never use it.
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
  AnyPlugin,
  CtxOf,
  EmptyShape,
  KernelCtx,
  NeedsShape,
  NoReservedKeys,
  Plugin,
  ServiceRecord,
  Token,
  WireNeeds,
} from './plugin-contract.js';
import { plugin, provide, token } from './plugin-contract.js';

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
  readonly boot?: (services: CtxOf<TNeeds> & KernelCtx) => MaybePromise<TProvides | void>;
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
  readonly boot?: (services: never) => MaybePromise<ServiceRecord | void>;
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
    /** Runtime services (escape hatch) — merged with the slice provide. */
    readonly boot?: (services: CtxOf<TNeeds> & KernelCtx) => MaybePromise<TProvides | void>;
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
  return {
    name,
    router: (config.router ?? {}) as TRouter,
    repos: (config.repos ?? {}) as TRepos,
    use: (config.use ?? []) as unknown as TUse,
    actions: config.actions ?? [],
    needs: (config.needs ?? {}) as TNeeds,
    boot: config.boot,
  };
}

export const FEATURE_ERROR_CODES = {
  duplicateRouterKey: 'FEATURE_E001',
  duplicateRepoKey: 'FEATURE_E002',
  duplicateSliceKey: 'FEATURE_E003',
  missingSlices: 'FEATURE_E004',
} as const;

export type FeatureErrorCode = (typeof FEATURE_ERROR_CODES)[keyof typeof FEATURE_ERROR_CODES];

/**
 * A mistake in how features are composed. The types reject the same
 * mistake at compile time; this is the backstop for code that skips them.
 */
export class FeatureError extends Error {
  readonly code: FeatureErrorCode;
  readonly remediation: string;

  constructor(args: { readonly code: FeatureErrorCode; readonly message: string; readonly remediation: string }) {
    super(args.message);
    this.name = 'FeatureError';
    this.code = args.code;
    this.remediation = args.remediation;
  }
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

type BootFnOf<F extends AnyFeature> = Exclude<F['boot'], undefined>;

type NonVoidProvides<T> = [Exclude<T, void>] extends [never]
  ? Record<never, never>
  : Exclude<T, void> extends ServiceRecord
    ? // A boot that returns only `void` gives `feature` no inference
      // candidate for TProvides, so TS falls back to the constraint — an
      // open `ServiceRecord` with a string index. That would read as
      // "provides every key" and collide with everything already mounted
      // (`db`, `kv`, …). Real provides always have literal keys, so an
      // index-signature record can only be that fallback: treat it as empty.
      string extends keyof Exclude<T, void>
      ? Record<never, never>
      : Exclude<T, void>
    : Record<never, never>;

/**
 * What the feature's boot escape hatch provides. `boot` is an optional
 * property, so `undefined` must be split off before matching the
 * function shape — and a void-only boot must resolve to an empty record
 * rather than `never` (a `never` arm would poison the whole provides
 * intersection).
 */
type ProvidesOf<F extends AnyFeature> = [BootFnOf<F>] extends [never]
  ? Record<never, never>
  : BootFnOf<F> extends (services: never) => infer R
    ? NonVoidProvides<Awaited<R>>
    : Record<never, never>;

/**
 * The plugin a feature becomes inside `.features()`. `WireNeeds` unwraps
 * the witness record to value types — the builder guard compares
 * availability against values, exactly as `plugin()` returns.
 */
export type PluginOf<F extends AnyFeature> = Plugin<
  WireNeeds<F['needs']>,
  ProvidesOf<F> & Readonly<Record<`feature.${F['name']}`, SlicePayloads<F['use']>>>
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

/** Compile one feature into the kernel unit the app mounts. Called by `.features()`. */
export function plug<F extends AnyFeature>(f: F): PluginOf<F> {
  const tok = tokenOf(f);
  const actions: ActionSource[] = [...f.actions, ...f.use.flatMap(slice => slice.actions)];

  const boot = async (ctx: CtxOf<F['needs']> & KernelCtx): Promise<ServiceRecord> => {
    const extra = f.boot === undefined ? undefined : await (f.boot as (services: unknown) => Promise<ServiceRecord | void>)(ctx);
    const payloads: Record<string, unknown> = {};
    for (const slice of f.use) {
      payloads[slice.key] = (slice.resolve as (services: unknown) => unknown)(ctx);
    }
    return { ...extra, ...provide(tok, payloads as SlicePayloads<F['use']>) };
  };

  // Factory seam: plugin()'s inference through the merged boot is erased
  // here and re-typed to the true shape declared above. feature()'s
  // signature already enforced NoReservedKeys on the caller's needs.
  return plugin({
    name: f.name,
    actions,
    needs: f.needs as NeedsShape & NoReservedKeys,
    boot: boot as (ctx: CtxOf<NeedsShape & NoReservedKeys> & KernelCtx) => Promise<ServiceRecord & NoReservedKeys>,
  }) as unknown as PluginOf<F>;
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
