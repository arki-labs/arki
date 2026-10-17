/**
 * Public entry point for the DOT kernel (v2).
 *
 * `defineApp(name)` returns a `DotAppBuilder` that accumulates units in three
 * hexagonal steps, then transitions through the 5-hook lifecycle:
 *
 *   defineApp -> use* -> features? -> serve* -> configure() -> boot() -> start() -> stop() -> dispose()
 *
 * The same three steps under their new names (RFC 2026-10-15-dot-feature-builder;
 * `.use()` / `.serve()` stay until the migration ends):
 *
 *   defineApp(name).infra(...).features([...]).entrypoints(...)
 *
 * `.use()` is compile-time guarded: a plugin whose `needs` are not satisfied
 * by services provided so far — or whose provides collide with existing
 * wire keys — fails to typecheck at the call site ("Expected 2 arguments,
 * but got 1", with the diagnostic embedded in the expected second
 * argument's type). Declaration order IS boot order.
 *
 * Most callers don't need to call `configure()` explicitly — `boot()` runs it
 * implicitly. `boot()` is also implicit when starting from `defined` via
 * `start()`.
 *
 * See `./lifecycle.ts` for hook semantics, failure ordering, idempotency rules.
 */

import type { AnyDefinedFeature } from './define-feature.js';
import type { DotDiagnosticsSnapshot } from './diagnostics.js';
import type { AnyFeature, Driven, Driver, MountedFeature, PluginOf } from './feature.js';
import type { DotLifecycleObserver } from './lifecycle-observer.js';
import type { DotLifecycleState } from './lifecycle.js';
import type { DotAppManifest } from './manifest.js';
import type { AnyPlugin, EmptyShape, Plugin, ServiceRecord } from './plugin-contract.js';
import type { MaxIndex, NextIndex } from './tuple-index.js';
import { allFeatures, mountFeatures } from './define-feature.js';
import { bindDriver, plug } from './feature.js';
import { DotAppImpl } from './kernel/app-instance.js';
import { renderTimeline } from './timeline.js';

/* ------------------------------------------------------------------ */
/* Compile-time wiring guard                                           */
/* ------------------------------------------------------------------ */

type MissingKeys<TAvail, TNeeds> = {
  readonly [K in Exclude<keyof TNeeds, keyof TAvail>]: TNeeds[K];
};

type MismatchedKeys<TAvail, TNeeds> = {
  readonly [K in keyof TAvail & keyof TNeeds as TAvail[K] extends TNeeds[K] ? never : K]: {
    readonly provided: TAvail[K];
    readonly needed: TNeeds[K];
  };
};

type NeedsError<TAvail extends ServiceRecord, TNeeds extends ServiceRecord> = {
  readonly 'DOT: this unit needs services that nothing before it provides. Mount their providers earlier (.use → .features → .serve)': {
    readonly missing: MissingKeys<TAvail, TNeeds>;
    readonly mismatched: MismatchedKeys<TAvail, TNeeds>;
  };
};

type CollisionError<TAvail, TProvides> = {
  readonly 'DOT: this unit provides a key that an earlier unit already provides. Give one of them a new key with rename()': keyof TAvail &
    keyof TProvides;
};

/**
 * A plugin whose `boot` always throws infers `TProvides = never`, which would
 * poison both the collision check (`keyof never` matches everything) and
 * the accumulated record (`TAvail & never` = `never`). Such a plugin provides
 * nothing — normalize to the empty shape.
 */
export type NormalizeProvides<TP extends ServiceRecord> = [TP] extends [never] ? EmptyShape : TP;

/**
 * One unit's wiring check. Satisfied → `[]`; violated → `[error]` with the
 * diagnostic as the error type. `ListGuard` turns it into a type on the
 * argument itself, so the call site fails on the plugin with the `DOT:`
 * label in the message (not with "Expected 2 arguments, but got 1").
 * The open record (`DotAppBuilder<ServiceRecord>`, the erased builder a
 * runtime-built plugin list gives) has nothing to check: the kernel checks
 * it at boot.
 */
export type UseGuard<
  TAvail extends ServiceRecord,
  TNeeds extends ServiceRecord,
  TProvides extends ServiceRecord,
> = string extends keyof TAvail
  ? []
  : [TAvail] extends [TNeeds]
    ? [keyof TAvail & keyof TProvides] extends [never]
      ? []
      : [error: CollisionError<TAvail, TProvides>]
    : [error: NeedsError<TAvail, TNeeds>];

/*
 * The list checks walk the tuple by index (`NextIndex`, see tuple-index.ts):
 * `TPlugins[I]` is one lookup, where `[infer Head, ...infer Tail]` would
 * re-slice the list at every step. A list longer than the table is refused
 * with a label.
 */

/**
 * Entry to the walk. The `[...infer All]` match is one copy of the tuple, and
 * it is what ends the walk for a GENERIC list: there `All` is its constraint
 * (`readonly AnyPlugin[]`), `0 extends number` holds, and the walk stops at
 * step 0 instead of expanding `NextIndex` forever while TypeScript computes
 * the conditional's constraint.
 */
type UseAllState<TAvail extends ServiceRecord, TPlugins extends readonly AnyPlugin[]> = TPlugins extends readonly [
  ...infer All extends readonly AnyPlugin[],
]
  ? UseAllWalk<TAvail, All, 0>
  : { readonly avail: TAvail; readonly error: never };

type UseAllWalk<
  TAvail extends ServiceRecord,
  TPlugins extends readonly AnyPlugin[],
  I extends number,
> = I extends TPlugins['length']
  ? { readonly avail: TAvail; readonly error: never }
  : I extends MaxIndex
    ? {
        readonly avail: TAvail;
        readonly error: { readonly 'DOT: a list may hold at most this many units': MaxIndex };
      }
    : TPlugins[I] extends Plugin<infer TNeeds, infer TProvides>
      ? UseGuard<TAvail, TNeeds, NormalizeProvides<TProvides>> extends []
        ? UseAllWalk<TAvail & NormalizeProvides<TProvides>, TPlugins, NextIndex[I]>
        : {
            readonly avail: TAvail;
            readonly error: {
              readonly 'DOT: a unit in this list cannot be mounted at its position': UseGuard<
                TAvail,
                TNeeds,
                NormalizeProvides<TProvides>
              >[0];
            };
          }
      : {
          readonly avail: TAvail;
          readonly error: {
            readonly 'DOT: this list accepts only plugins': TPlugins[I];
          };
        };

export type UseAllAvail<TAvail extends ServiceRecord, TPlugins extends readonly AnyPlugin[]> = UseAllState<
  TAvail,
  TPlugins
>['avail'];

type UseAllTupleGuard<TPlugins extends readonly AnyPlugin[]> = number extends TPlugins['length']
  ? [
      error: {
        readonly 'DOT: pass a tuple. Add `as const`, or list the units inline in boot order': TPlugins;
      },
    ]
  : [];

export type UseAllGuard<TAvail extends ServiceRecord, TPlugins extends readonly AnyPlugin[]> = [
  UseAllState<TAvail, TPlugins>['error'],
] extends [never]
  ? UseAllTupleGuard<TPlugins>
  : [error: UseAllState<TAvail, TPlugins>['error']];

/**
 * `UseAllGuard` as a rest-parameter check: `unknown` when the list mounts,
 * otherwise the error record — intersected with the argument tuple, so the
 * call fails with the diagnostic in the expected type.
 */
export type ListGuard<TGuard extends readonly unknown[]> = TGuard extends readonly [error: infer TError]
  ? TError
  : unknown;

/** A list of plugins and adapters, each seen as the plugin it mounts (an adapter's `bind` result). */
type AsPlugins<TUnits extends readonly unknown[]> = {
  readonly [K in keyof TUnits]: TUnits[K] extends { readonly bind: (features: never) => infer TPlugin }
    ? TPlugin
    : TUnits[K];
};

/** The kernel units one feature mounts: a `defineFeature` feature's `plugins()`, or the object-form feature's plugin. */
type UnitsOfFeature<TFeature> = TFeature extends { plugins(): infer TUnits extends readonly AnyPlugin[] }
  ? TUnits
  : TFeature extends AnyFeature
    ? readonly [PluginOf<TFeature>]
    : never;

/** Index walk (see `NextIndex` / `UseAllState`): `[infer Head, ...infer Tail]` would re-slice the list at every feature. */
type FlattenUnits<TFeatures extends readonly unknown[]> = TFeatures extends readonly [
  ...infer All extends readonly unknown[],
]
  ? FlattenWalk<All, 0, readonly []>
  : readonly AnyPlugin[];
type FlattenWalk<
  TFeatures extends readonly unknown[],
  I extends number,
  TAcc extends readonly AnyPlugin[],
> = I extends TFeatures['length']
  ? TAcc
  : I extends MaxIndex
    ? readonly AnyPlugin[]
    : FlattenWalk<TFeatures, NextIndex[I], readonly [...TAcc, ...UnitsOfFeature<TFeatures[I]>]>;

/**
 * Every kernel unit a feature list mounts, flattened in order — what
 * `.features()` checks with the `UseAllGuard`. A non-tuple list stays an
 * array, so the guard asks for a tuple.
 */
export type FeatureUnits<TFeatures extends readonly (AnyFeature | AnyDefinedFeature)[]> =
  number extends TFeatures['length'] ? readonly AnyPlugin[] : FlattenUnits<TFeatures>;

/* ------------------------------------------------------------------ */
/* Public app surface                                                  */
/* ------------------------------------------------------------------ */

/**
 * Public DotApp surface. The internal `DotAppImpl` implements this; consumers
 * see only these members.
 */
export type DotApp<TServices extends ServiceRecord> = {
  /** App name (passed to `defineApp`). */
  readonly name: string;
  /** Current lifecycle state. */
  readonly state: DotLifecycleState;
  /**
   * Services published by booted plugins, keyed by wire key.
   * Empty before `boot()` succeeds.
   */
  readonly services: TServices;
  /** Declarative manifest — describes the static shape of the app. */
  readonly manifest: DotAppManifest;
  /** Point-in-time diagnostics snapshot. Re-computed on every access. */
  readonly diagnostics: DotDiagnosticsSnapshot;
  /**
   * Start active work. Boots first if app is `defined` or `configured`.
   * Idempotent while `started`. Throws if app is `failed` or `disposed`.
   */
  start(): Promise<void>;
  /**
   * Stop active work. Keeps booted resources for later cleanup.
   * Idempotent while not `started`.
   */
  stop(): Promise<void>;
  /**
   * Release booted resources. Runs stop() first if `started`.
   * Idempotent while `disposed`.
   */
  dispose(): Promise<void>;
  /**
   * Register an in-process lifecycle observer. Returns an unsubscribe
   * function. Observers added here see events from this point onward —
   * pass observers through `defineApp(name, { observers })` to catch
   * `configure`-phase events too.
   */
  subscribe(observer: DotLifecycleObserver): () => void;
  /**
   * Render the recorded lifecycle as an ASCII waterfall. Reads from
   * the current `diagnostics` snapshot — call after `boot()` /
   * `dispose()` / a failure to see the full picture.
   */
  timeline(): string;
};

/**
 * Intermediate type after `configure()` but before `boot()`.
 * Exposes the manifest and diagnostics already, but no `services` yet.
 */
export type DotAppConfigured<TServices extends ServiceRecord> = {
  readonly name: string;
  readonly state: DotLifecycleState;
  readonly manifest: DotAppManifest;
  readonly diagnostics: DotDiagnosticsSnapshot;
  /** Continue the lifecycle. */
  boot(): Promise<DotApp<TServices>>;
  start(): Promise<DotApp<TServices>>;
  /** See {@link DotApp.subscribe}. */
  subscribe(observer: DotLifecycleObserver): () => void;
  /** See {@link DotApp.timeline}. */
  timeline(): string;
};

/** Lifecycle entry points every builder phase shares. */
export type DotAppLifecycle<TAvail extends ServiceRecord> = {
  /** Run the configure phase synchronously. Throws on configure failure. */
  configure(): DotAppConfigured<TAvail>;
  /** Run configure + boot. Throws on configure or boot failure. */
  boot(): Promise<DotApp<TAvail>>;
  /** Convenience: configure + boot + start. */
  start(): Promise<DotApp<TAvail>>;
};

/**
 * Builder after `.features()` or `.serve()` — only driving adapters remain.
 * Driven adapters (`.use`) cannot follow the domain: infrastructure never
 * depends on a feature.
 */
export type DotServeBuilder<TAvail extends ServiceRecord> = DotAppLifecycle<TAvail> & {
  /**
   * Register a driving adapter (HTTP server, job worker, scheduler). A
   * `driver(...)` is bound to the features mounted by `.features()`; a
   * plain plugin is mounted as-is. Same compile-time guard as `.use()`.
   */
  serve<TNeeds extends ServiceRecord, TProvides extends ServiceRecord>(
    adapter: (Plugin<TNeeds, TProvides> | Driver<TNeeds, TProvides>) &
      ListGuard<UseGuard<TAvail, TNeeds, NormalizeProvides<TProvides>>>,
  ): DotServeBuilder<TAvail & NormalizeProvides<TProvides>>;
  /**
   * Register the app's entrypoints — what calls into the features (HTTP
   * gateway, scheduler, job worker), in order. Each `driver(...)` is bound to
   * the mounted features; a plain plugin is mounted as-is. The whole list is
   * checked like `.useAll()`.
   */
  entrypoints<const TAdapters extends readonly (AnyPlugin | Driver)[]>(
    ...adapters: TAdapters & ListGuard<UseAllGuard<TAvail, Extract<AsPlugins<TAdapters>, readonly AnyPlugin[]>>>
  ): DotServeBuilder<UseAllAvail<TAvail, Extract<AsPlugins<TAdapters>, readonly AnyPlugin[]>>>;
};

/**
 * Builder produced by `defineApp(name)`. The app reads as a hexagon:
 *
 *   .use(...)        driven adapters — what features need (db, kv, queue client)
 *   .features([...]) the domain core
 *   .serve(...)      driving adapters — what calls the features (http, workers)
 *
 * Each step is type-tracking in both directions: a unit's `needs` must be
 * satisfied by the services accumulated so far, and its `provides` merge
 * into the accumulated record for the next step.
 */
export type DotAppBuilder<TAvail extends ServiceRecord> = DotAppLifecycle<TAvail> & {
  /**
   * Register a driven adapter. Compile error when the plugin's needs are
   * unsatisfied or its provides collide with existing wire keys.
   *
   * A `driven(...)` adapter is bound when the app is built, to the full
   * feature list — so it can read the features' static declarations (their
   * `use` slices) while still booting BEFORE them. A `driver(...)` is
   * rejected here: it calls into the features, so it belongs in `.serve()`.
   */
  use<TNeeds extends ServiceRecord, TProvides extends ServiceRecord>(
    plugin: (Plugin<TNeeds, TProvides> | Driven<TNeeds, TProvides>) &
      ListGuard<UseGuard<TAvail, TNeeds, NormalizeProvides<TProvides>>>,
  ): DotAppBuilder<TAvail & NormalizeProvides<TProvides>>;
  /**
   * Register a tuple of plugins in declaration order. This is type-equivalent
   * to calling `.use()` for each item and keeps the same ordering/collision
   * guard across the whole tuple.
   */
  useAll<const TPlugins extends readonly AnyPlugin[]>(
    plugins: TPlugins & ListGuard<UseAllGuard<TAvail, TPlugins>>,
  ): DotAppBuilder<UseAllAvail<TAvail, TPlugins>>;
  /**
   * Register what the app runs on — logging, observability, database,
   * cache, auth, the journal — in boot order (argument order; keep `log(...)`
   * first). Plugins and `driven(...)` adapters; the whole list is checked
   * like `.useAll()`. Every feature sees these by handle.
   */
  infra<const TUnits extends readonly (AnyPlugin | Driven)[]>(
    ...units: TUnits & ListGuard<UseAllGuard<TAvail, Extract<AsPlugins<TUnits>, readonly AnyPlugin[]>>>
  ): DotAppBuilder<UseAllAvail<TAvail, Extract<AsPlugins<TUnits>, readonly AnyPlugin[]>>>;
  /**
   * Mount the domain features, in order. A feature may need what earlier
   * features provide. Takes object-form `feature()` values and
   * `defineFeature()` features (each mounts its infra plugins, then itself).
   * Called once: after it, only `.serve()` / `.entrypoints()` remain.
   */
  features<const TFeatures extends readonly (AnyFeature | AnyDefinedFeature)[]>(
    features: TFeatures & ListGuard<UseAllGuard<TAvail, Extract<FeatureUnits<TFeatures>, readonly AnyPlugin[]>>>,
  ): DotServeBuilder<UseAllAvail<TAvail, Extract<FeatureUnits<TFeatures>, readonly AnyPlugin[]>>>;
} & Pick<DotServeBuilder<TAvail>, 'serve' | 'entrypoints'>;

type BuilderState = {
  appName: string;
  appVersion?: string;
  /** A `Driven` is bound to the final feature list at build time. */
  plugins: (AnyPlugin | Driven)[];
  /** The features mounted by `.features()`, as written — what drivers are bound to. */
  features: readonly MountedFeature[];
  config?: Readonly<Record<string, unknown>>;
  observers?: readonly DotLifecycleObserver[];
  hookTimeoutMs?: number;
};

/**
 * Create a new DOT app builder.
 *
 * @example
 * const app = await defineApp('my-app')
 *   .use(dbPlugin)
 *   .use(billingPlugin)   // billing's needs must be satisfied by now
 *   .boot();
 *
 * await app.start();
 * console.log(app.manifest);
 * // ...
 * await app.dispose();
 */
export function defineApp(
  name: string,
  options: {
    version?: string;
    config?: Readonly<Record<string, unknown>>;
    /**
     * In-process lifecycle observers, registered before the first phase
     * fires. Required if you want to see `configure`-phase events — after
     * configure runs, observers can be added post-hoc via
     * `configured.subscribe(...)` or `app.subscribe(...)`.
     */
    observers?: readonly DotLifecycleObserver[];
    /**
     * Watchdog budget (ms) for each async hook invocation (`boot`, `start`,
     * `stop`, `dispose` — `configure` is sync). A hook exceeding the budget
     * fails with `ARKI_DOT_E015` naming the plugin and hook, and the
     * kernel applies its normal failure rules (boot rollback, teardown
     * aggregation). The hook's promise itself cannot be cancelled — the
     * watchdog makes the hang *visible*, it does not kill it. Default:
     * no watchdog.
     */
    hookTimeoutMs?: number;
  } = {},
): DotAppBuilder<EmptyShape> {
  const state: BuilderState = {
    appName: name,
    appVersion: options.version,
    plugins: [],
    features: [],
    config: options.config,
    observers: options.observers,
    hookTimeoutMs: options.hookTimeoutMs,
  };
  return makeBuilder<EmptyShape>(state);
}

function buildImpl(state: BuilderState): DotAppImpl {
  return new DotAppImpl({
    appName: state.appName,
    appVersion: state.appVersion,
    plugins: state.plugins.map(unit => ('bind' in unit ? (unit.bind(state.features) as AnyPlugin) : unit)),
    config: state.config,
    observers: state.observers,
    hookTimeoutMs: state.hookTimeoutMs,
  });
}

function isDefinedFeature(f: AnyFeature | AnyDefinedFeature): f is AnyDefinedFeature {
  return 'plugins' in f && typeof f.plugins === 'function';
}

function bindAdapter(adapter: AnyPlugin | Driver, features: readonly MountedFeature[]): AnyPlugin {
  const bound: AnyPlugin = 'bind' in adapter ? bindDriver(adapter, features) : adapter;
  return { ...bound, role: 'driving' };
}

function makeBuilder<TAvail extends ServiceRecord>(state: BuilderState): DotAppBuilder<TAvail> {
  // The `use` implementation is signature-erased (the guard exists purely
  // at the type level); the single cast below is the same kernel boundary
  // v1 crossed in its wrapApp helper. The phase split is type-only too:
  // one runtime object serves every phase.
  const impl = {
    features(features: readonly (AnyFeature | AnyDefinedFeature)[]): DotAppBuilder<ServiceRecord> {
      // Assembly: a chain feature's raw infra handles may be held only inside its scope (ARKI_DOT_E026 otherwise).
      mountFeatures(features.filter(f => isDefinedFeature(f)));
      const nextState: BuilderState = {
        ...state,
        plugins: [
          ...state.plugins,
          ...features.flatMap((f): readonly AnyPlugin[] =>
            isDefinedFeature(f) ? f.plugins() : [{ ...(plug(f) as AnyPlugin), role: 'feature' }],
          ),
        ],
        // Adapters read both forms through the descriptor protocol (`entrypointsOf`). The list is the
        // normalized node list — each nested feature once, depth-first — so a driver (`.entrypoints`) and a
        // driven adapter (`.infra`) read each node's own declarations exactly once.
        features: [...state.features, ...allFeatures(features)],
      };
      return makeBuilder<ServiceRecord>(nextState);
    },
    serve(adapter: AnyPlugin | Driver): DotAppBuilder<ServiceRecord> {
      const nextState: BuilderState = {
        ...state,
        plugins: [...state.plugins, bindAdapter(adapter, state.features)],
      };
      return makeBuilder<ServiceRecord>(nextState);
    },
    entrypoints(...adapters: readonly (AnyPlugin | Driver)[]): DotAppBuilder<ServiceRecord> {
      const nextState: BuilderState = {
        ...state,
        plugins: [...state.plugins, ...adapters.map(adapter => bindAdapter(adapter, state.features))],
      };
      return makeBuilder<ServiceRecord>(nextState);
    },
    infra(...units: readonly (AnyPlugin | Driven)[]): DotAppBuilder<ServiceRecord> {
      const nextState: BuilderState = {
        ...state,
        plugins: [...state.plugins, ...units],
      };
      return makeBuilder<ServiceRecord>(nextState);
    },
    use(plugin: AnyPlugin | Driven): DotAppBuilder<ServiceRecord> {
      const nextState: BuilderState = {
        ...state,
        plugins: [...state.plugins, plugin],
      };
      return makeBuilder<ServiceRecord>(nextState);
    },
    useAll(plugins: readonly AnyPlugin[]): DotAppBuilder<ServiceRecord> {
      const nextState: BuilderState = {
        ...state,
        plugins: [...state.plugins, ...plugins],
      };
      return makeBuilder<ServiceRecord>(nextState);
    },
    configure(): DotAppConfigured<ServiceRecord> {
      const appImpl = buildImpl(state);
      appImpl.runConfigure();
      return wrapConfigured<ServiceRecord>(appImpl);
    },
    async boot(): Promise<DotApp<ServiceRecord>> {
      const appImpl = buildImpl(state);
      await appImpl.boot();
      return wrapApp<ServiceRecord>(appImpl);
    },
    async start(): Promise<DotApp<ServiceRecord>> {
      const appImpl = buildImpl(state);
      await appImpl.start();
      return wrapApp<ServiceRecord>(appImpl);
    },
  };
  return impl as DotAppBuilder<TAvail>;
}

function wrapApp<TServices extends ServiceRecord>(impl: DotAppImpl): DotApp<TServices> {
  return {
    get name() {
      return impl.name;
    },
    get state() {
      return impl.state;
    },
    get services() {
      return impl.services as TServices;
    },
    get manifest() {
      return impl.manifest;
    },
    get diagnostics() {
      return impl.diagnostics;
    },
    start: () => impl.start(),
    stop: () => impl.stop(),
    dispose: () => impl.dispose(),
    subscribe: observer => impl.subscribe(observer),
    timeline: () => renderTimeline(impl.diagnostics),
  };
}

function wrapConfigured<TServices extends ServiceRecord>(impl: DotAppImpl): DotAppConfigured<TServices> {
  return {
    get name() {
      return impl.name;
    },
    get state() {
      return impl.state;
    },
    get manifest() {
      return impl.manifest;
    },
    get diagnostics() {
      return impl.diagnostics;
    },
    async boot() {
      await impl.boot();
      return wrapApp<TServices>(impl);
    },
    async start() {
      await impl.start();
      return wrapApp<TServices>(impl);
    },
    subscribe: observer => impl.subscribe(observer),
    timeline: () => renderTimeline(impl.diagnostics),
  };
}
