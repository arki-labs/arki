/**
 * @arki/feature — feature declarations for ARKI backends.
 *
 * A feature is a named, engine-neutral declaration of what one domain
 * module contributes to an app:
 *
 * - `router` / `repos` — compile-time fragments. Fold them with
 *   `composeRouter` / `composeRepos` from one membership list; no
 *   kernel is involved, so tests and plain scripts consume them
 *   directly.
 * - `use` — boot-time slices (jobs, schedules, HTTP routes) declared
 *   through slice contracts exported by the adapter that consumes them
 *   (e.g. `jobs()` from `@arki/queue/dot`). Each contract carries its
 *   payload plus the manifest actions derived from it, so this package
 *   depends on no adapter and the slice set stays open.
 * - `needs` / `boot` — the runtime escape hatch for genuine lifecycle
 *   (an auth instance, an event store). Most features never use it.
 *
 * Plugging a feature into a DOT app is a separate projection: see
 * `@arki/feature/dot` (`plug`, `plugs`, `tokens`). Everything imported
 * from `@arki/dot` here is type-only — this entry point has no runtime
 * dependencies.
 */
import type { ActionSource, CtxOf, EmptyShape, KernelCtx, NeedsShape, NoReservedKeys, ServiceRecord } from '@arki/dot/plugin';

export type MaybePromise<T> = T | Promise<T>;

export type RouterFragments = Record<string, unknown>;
export type RepoFactories = Record<string, (database: never) => unknown>;

/**
 * A boot-time slice contract. Adapter packages export factories that
 * produce these (`jobs()`, `schedules()`, `endpoints()`): the payload
 * lands under `key` in the feature's published slice record, and the
 * `actions` derived from the payload join the feature's manifest. The
 * shape is structural on purpose — an adapter can mint slices without
 * importing this package.
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
  /** Runtime escape hatch — consumed by the plug projection. */
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
 * Declare a feature. Pure data capture — nothing executes here, and no
 * engine is referenced; the DOT projection happens in
 * `@arki/feature/dot`.
 */
export function defineFeature<
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

export type ComposedRouter<T extends readonly AnyFeature[]> = UnionToIntersection<T[number]['router']>;

/**
 * Fold the features' router fragments into one router — value AND type
 * from the single list. A mount key claimed by two features throws at
 * module load.
 */
export function composeRouter<const T extends readonly AnyFeature[]>(features: T): ComposedRouter<T> {
  const merged: Record<string, unknown> = {};
  for (const f of features) {
    for (const [key, fragment] of Object.entries(f.router)) {
      if (key in merged) {
        throw new Error(`[feature] router mount key "${key}" is contributed by more than one feature.`);
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

/** Fold the features' repo factories over one db handle. */
export function composeRepos<const T extends readonly AnyFeature[]>(
  features: T,
  database: RepoDatabaseOf<T>,
): ComposedRepos<T> {
  const repos: Record<string, unknown> = {};
  for (const f of features) {
    for (const [key, factory] of Object.entries(f.repos)) {
      if (key in repos) {
        throw new Error(`[feature] repo key "${key}" is contributed by more than one feature.`);
      }
      repos[key] = (factory as (db: RepoDatabaseOf<T>) => unknown)(database);
    }
  }
  return repos as ComposedRepos<T>;
}
