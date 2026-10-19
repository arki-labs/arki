import type { Clock } from '@arki/clock';
import type { Failure, FailureIn } from '@arki/failure';
import { isFailure } from '@arki/failure';

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
import type { DotBootOutcome, DotDisposeOutcome } from './kernel/app-instance.js';
import type { DotLifecycleObserver } from './lifecycle-observer.js';
import type { DotLifecycleState } from './lifecycle.js';
import type { DotAppManifest } from './manifest.js';
import type {
  AnyPlugin,
  EmptyShape,
  NeedsShape,
  Plugin,
  PluginCloseFailure,
  PluginOpenFailure,
  PluginOwnership,
  RuntimePlugin,
  ServiceRecord,
} from './plugin-contract.js';
import type { MaxIndex, NextIndex } from './tuple-index.js';
import { allFeatures, mountFeatures } from './define-feature.js';
import { bindDriver, plug } from './feature.js';
import { DotAppImpl } from './kernel/app-instance.js';
import { renderTimeline } from './timeline.js';

function failed<Value>(value: Value): value is FailureIn<Value> {
  return isFailure<unknown>(value);
}

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
    : TPlugins[I] extends Plugin<infer TNeeds, infer TProvides, NeedsShape, string, PluginOwnership>
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
export type DotApp<TServices extends ServiceRecord, TClose extends Failure = never, TOpen extends Failure = never> = {
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
  start(): Promise<DotBootOutcome<TOpen, TClose>>;
  /**
   * Stop active work. Keeps booted resources for later cleanup.
   * Idempotent while not `started`.
   */
  stop(): Promise<void>;
  /**
   * Release booted resources. Runs stop() first if `started`.
   * Idempotent while `disposed`.
   */
  dispose(): Promise<DotDisposeOutcome<TClose>>;
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
export type DotAppConfigured<
  TServices extends ServiceRecord,
  TOpen extends Failure = never,
  TClose extends Failure = never,
> = {
  readonly name: string;
  readonly state: DotLifecycleState;
  readonly manifest: DotAppManifest;
  readonly diagnostics: DotDiagnosticsSnapshot;
  /** Continue the lifecycle. */
  boot(): Promise<DotApp<TServices, TClose, TOpen> | Exclude<DotBootOutcome<TOpen, TClose>, void>>;
  start(): Promise<DotApp<TServices, TClose, TOpen> | Exclude<DotBootOutcome<TOpen, TClose>, void>>;
  /** See {@link DotApp.subscribe}. */
  subscribe(observer: DotLifecycleObserver): () => void;
  /** See {@link DotApp.timeline}. */
  timeline(): string;
};

/** Lifecycle entry points every builder phase shares. */
export type DotAppLifecycle<
  TAvail extends ServiceRecord,
  TOpen extends Failure = never,
  TClose extends Failure = never,
> = Pick<Builder<TAvail, TOpen, TClose>, 'configure' | 'boot' | 'start'>;

/**
 * Builder after `.features()` or `.serve()` — only driving adapters remain.
 * Driven adapters (`.use`) cannot follow the domain: infrastructure never
 * depends on a feature.
 */
export type DotServeBuilder<
  TAvail extends ServiceRecord,
  TOpen extends Failure = never,
  TClose extends Failure = never,
> = Pick<Builder<TAvail, TOpen, TClose>, keyof DotAppLifecycle<TAvail, TOpen, TClose> | 'serve' | 'entrypoints'>;

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
export type DotAppBuilder<
  TAvail extends ServiceRecord,
  TOpen extends Failure = never,
  TClose extends Failure = never,
> = Pick<Builder<TAvail, TOpen, TClose>, keyof Builder<TAvail, TOpen, TClose>>;

type BuilderState<TOpen extends Failure = never, TClose extends Failure = never> = {
  appName: string;
  appVersion?: string;
  /** A `Driven` is bound to the final feature list at build time. */
  plugins: (RuntimePlugin<TOpen, TClose> | Driven<ServiceRecord, ServiceRecord, { open: TOpen; close: TClose }>)[];
  /** The features mounted by `.features()`, as written — what drivers are bound to. */
  features: readonly MountedFeature[];
  config?: Readonly<Record<string, unknown>>;
  observers?: readonly DotLifecycleObserver[];
  hookTimeoutMs?: number;
  clock?: Clock;
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
    clock?: Clock;
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
    clock: options.clock,
  };
  return makeBuilder<EmptyShape>(state);
}

function buildImpl<TOpen extends Failure, TClose extends Failure>(
  state: BuilderState<TOpen, TClose>,
): DotAppImpl<TOpen, TClose> {
  return new DotAppImpl({
    appName: state.appName,
    appVersion: state.appVersion,
    plugins: state.plugins.map(unit => ('bind' in unit ? unit.bind(state.features) : unit)),
    config: state.config,
    observers: state.observers,
    hookTimeoutMs: state.hookTimeoutMs,
    clock: state.clock,
  });
}

function isDefinedFeature(f: AnyFeature | AnyDefinedFeature): f is AnyDefinedFeature {
  return 'plugins' in f && typeof f.plugins === 'function';
}

function bindAdapter(adapter: AnyPlugin | Driver, features: readonly MountedFeature[]): AnyPlugin {
  const bound: AnyPlugin = 'bind' in adapter ? bindDriver(adapter, features) : adapter;
  return { ...bound, role: 'driving' };
}

/** Runtime lists retain the checked construct/close objects from their source plugins. */
function pluginRuntime<const Plugins extends readonly AnyPlugin[]>(
  plugins: Plugins,
): readonly RuntimePlugin<PluginOpenFailure<Plugins[number]>, PluginCloseFailure<Plugins[number]>>[];
function pluginRuntime(plugins: readonly AnyPlugin[]): readonly AnyPlugin[] {
  return plugins;
}
function runtimeUnits<const Units extends readonly (AnyPlugin | Driven)[]>(
  units: Units,
): readonly (
  | RuntimePlugin<PluginOpenFailure<AsPlugins<Units>[number]>, PluginCloseFailure<AsPlugins<Units>[number]>>
  | Driven<
      ServiceRecord,
      ServiceRecord,
      { open: PluginOpenFailure<AsPlugins<Units>[number]>; close: PluginCloseFailure<AsPlugins<Units>[number]> }
    >
)[];
function runtimeUnits(units: readonly (AnyPlugin | Driven)[]): readonly (AnyPlugin | Driven)[] {
  return units;
}
function featureRuntime<const Features extends readonly (AnyFeature | AnyDefinedFeature)[]>(
  features: Features,
): readonly RuntimePlugin<
  PluginOpenFailure<FeatureUnits<Features>[number]>,
  PluginCloseFailure<FeatureUnits<Features>[number]>
>[];
function featureRuntime(features: readonly (AnyFeature | AnyDefinedFeature)[]): readonly AnyPlugin[] {
  mountFeatures(features.filter(f => isDefinedFeature(f)));
  return features.flatMap(f => (isDefinedFeature(f) ? f.plugins() : [{ ...plug(f), role: 'feature' as const }]));
}
function drivingRuntime<const Adapters extends readonly (AnyPlugin | Driver)[]>(
  adapters: Adapters,
  features: readonly MountedFeature[],
): readonly RuntimePlugin<
  PluginOpenFailure<AsPlugins<Adapters>[number]>,
  PluginCloseFailure<AsPlugins<Adapters>[number]>
>[];
function drivingRuntime(
  adapters: readonly (AnyPlugin | Driver)[],
  features: readonly MountedFeature[],
): readonly AnyPlugin[] {
  return adapters.map(adapter => bindAdapter(adapter, features));
}

/** Internal dynamic-list entrypoint; unlike useAll, this does not claim tuple wiring checks. */
export function mountPlugins<
  Open extends Failure,
  Close extends Failure,
  Services extends ServiceRecord = ServiceRecord,
>(
  name: string,
  plugins: readonly RuntimePlugin<Open, Close>[],
  options: Parameters<typeof defineApp>[1] = {},
): DotAppBuilder<Services, Open, Close> {
  return makeBuilder<Services, Open, Close>({
    appName: name,
    appVersion: options.version,
    plugins: [...plugins],
    features: [],
    config: options.config,
    observers: options.observers,
    hookTimeoutMs: options.hookTimeoutMs,
    clock: options.clock,
  });
}

function makeBuilder<TAvail extends ServiceRecord, TOpen extends Failure = never, TClose extends Failure = never>(
  state: BuilderState<TOpen, TClose>,
): DotAppBuilder<TAvail, TOpen, TClose> {
  return new Builder<TAvail, TOpen, TClose>(state);
}

/** One checked implementation supplies both public builder phases. */
class Builder<TAvail extends ServiceRecord, TOpen extends Failure, TClose extends Failure> {
  readonly #state: BuilderState<TOpen, TClose>;

  constructor(state: BuilderState<TOpen, TClose>) {
    this.#state = state;

    this.use = this.use.bind(this);
    this.useAll = this.useAll.bind(this);
    this.infra = this.infra.bind(this);
    this.features = this.features.bind(this);
    this.serve = this.serve.bind(this);
    this.entrypoints = this.entrypoints.bind(this);
    this.configure = this.configure.bind(this);
    this.boot = this.boot.bind(this);
    this.start = this.start.bind(this);
  }

  private append<Avail extends ServiceRecord, Open extends Failure, Close extends Failure>(
    units: readonly (RuntimePlugin<Open, Close> | Driven<ServiceRecord, ServiceRecord, { open: Open; close: Close }>)[],
    features = this.#state.features,
  ): Builder<Avail, TOpen | Open, TClose | Close> {
    return new Builder<Avail, TOpen | Open, TClose | Close>({
      ...this.#state,
      plugins: [...this.#state.plugins, ...units],
      features,
    });
  }

  /** Register a driven adapter whose needs are already available. */
  use<Needs extends ServiceRecord, Provides extends ServiceRecord, Owned extends PluginOwnership>(
    unit: (Plugin<Needs, Provides, NeedsShape, string, Owned> | Driven<Needs, Provides, Owned>) &
      ListGuard<UseGuard<TAvail, Needs, NormalizeProvides<Provides>>>,
  ): DotAppBuilder<TAvail & NormalizeProvides<Provides>, TOpen | Owned['open'], TClose | Owned['close']> {
    return this.append<TAvail & NormalizeProvides<Provides>, Owned['open'], Owned['close']>([unit]);
  }

  /** Register a tuple of plugins in declaration order. */
  useAll<const Plugins extends readonly AnyPlugin[]>(
    plugins: Plugins & ListGuard<UseAllGuard<TAvail, Plugins>>,
  ): DotAppBuilder<
    UseAllAvail<TAvail, Plugins>,
    TOpen | PluginOpenFailure<Plugins[number]>,
    TClose | PluginCloseFailure<Plugins[number]>
  > {
    return this.append<
      UseAllAvail<TAvail, Plugins>,
      PluginOpenFailure<Plugins[number]>,
      PluginCloseFailure<Plugins[number]>
    >(pluginRuntime<Plugins>(plugins));
  }

  /** Register infrastructure in boot order, before the domain. */
  infra<const Units extends readonly (AnyPlugin | Driven)[]>(
    ...units: Units & ListGuard<UseAllGuard<TAvail, Extract<AsPlugins<Units>, readonly AnyPlugin[]>>>
  ): DotAppBuilder<
    UseAllAvail<TAvail, Extract<AsPlugins<Units>, readonly AnyPlugin[]>>,
    TOpen | PluginOpenFailure<AsPlugins<Units>[number]>,
    TClose | PluginCloseFailure<AsPlugins<Units>[number]>
  > {
    return this.append<
      UseAllAvail<TAvail, Extract<AsPlugins<Units>, readonly AnyPlugin[]>>,
      PluginOpenFailure<AsPlugins<Units>[number]>,
      PluginCloseFailure<AsPlugins<Units>[number]>
    >(runtimeUnits<Units>(units));
  }

  /** Mount the domain; later steps can register only driving adapters. */
  features<const Features extends readonly (AnyFeature | AnyDefinedFeature)[]>(
    features: Features & ListGuard<UseAllGuard<TAvail, Extract<FeatureUnits<Features>, readonly AnyPlugin[]>>>,
  ): DotServeBuilder<
    UseAllAvail<TAvail, Extract<FeatureUnits<Features>, readonly AnyPlugin[]>>,
    TOpen | PluginOpenFailure<FeatureUnits<Features>[number]>,
    TClose | PluginCloseFailure<FeatureUnits<Features>[number]>
  > {
    return this.append<
      UseAllAvail<TAvail, Extract<FeatureUnits<Features>, readonly AnyPlugin[]>>,
      PluginOpenFailure<FeatureUnits<Features>[number]>,
      PluginCloseFailure<FeatureUnits<Features>[number]>
    >(featureRuntime<Features>(features), [...this.#state.features, ...allFeatures(features)]);
  }

  /** Bind a driving adapter to the features mounted by features(). */
  serve<Needs extends ServiceRecord, Provides extends ServiceRecord, Owned extends PluginOwnership>(
    adapter: (Plugin<Needs, Provides, NeedsShape, string, Owned> | Driver<Needs, Provides, Owned>) &
      ListGuard<UseGuard<TAvail, Needs, NormalizeProvides<Provides>>>,
  ): DotServeBuilder<TAvail & NormalizeProvides<Provides>, TOpen | Owned['open'], TClose | Owned['close']> {
    const bound = 'bind' in adapter ? bindDriver(adapter, this.#state.features) : adapter;
    return this.append<TAvail & NormalizeProvides<Provides>, Owned['open'], Owned['close']>([
      { ...bound, role: 'driving' },
    ]);
  }

  /** Register the app's driving adapters in argument order. */
  entrypoints<const Adapters extends readonly (AnyPlugin | Driver)[]>(
    ...adapters: Adapters & ListGuard<UseAllGuard<TAvail, Extract<AsPlugins<Adapters>, readonly AnyPlugin[]>>>
  ): DotServeBuilder<
    UseAllAvail<TAvail, Extract<AsPlugins<Adapters>, readonly AnyPlugin[]>>,
    TOpen | PluginOpenFailure<AsPlugins<Adapters>[number]>,
    TClose | PluginCloseFailure<AsPlugins<Adapters>[number]>
  > {
    return this.append<
      UseAllAvail<TAvail, Extract<AsPlugins<Adapters>, readonly AnyPlugin[]>>,
      PluginOpenFailure<AsPlugins<Adapters>[number]>,
      PluginCloseFailure<AsPlugins<Adapters>[number]>
    >(drivingRuntime<Adapters>(adapters, this.#state.features));
  }

  configure() {
    const impl = buildImpl(this.#state);
    impl.runConfigure();
    return wrapConfigured<TAvail, TOpen, TClose>(impl);
  }

  async boot(): Promise<DotApp<TAvail, TClose, TOpen> | Exclude<DotBootOutcome<TOpen, TClose>, void>> {
    const impl = buildImpl(this.#state);
    const outcome = await impl.boot();
    if (failed(outcome)) return outcome;
    return wrapApp<TAvail, TOpen, TClose>(impl);
  }

  async start(): Promise<DotApp<TAvail, TClose, TOpen> | Exclude<DotBootOutcome<TOpen, TClose>, void>> {
    const impl = buildImpl(this.#state);
    const outcome = await impl.start();
    if (failed(outcome)) return outcome;
    return wrapApp<TAvail, TOpen, TClose>(impl);
  }
}

function wrapApp<TServices extends ServiceRecord, TOpen extends Failure, TClose extends Failure>(
  impl: DotAppImpl<TOpen, TClose>,
): DotApp<TServices, TClose, TOpen> {
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

function wrapConfigured<TServices extends ServiceRecord, TOpen extends Failure, TClose extends Failure>(
  impl: DotAppImpl<TOpen, TClose>,
): DotAppConfigured<TServices, TOpen, TClose> {
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
      const result = await impl.boot();
      if (failed(result)) return result;
      return wrapApp<TServices, TOpen, TClose>(impl);
    },
    async start() {
      const result = await impl.start();
      if (failed(result)) return result;
      return wrapApp<TServices, TOpen, TClose>(impl);
    },
    subscribe: observer => impl.subscribe(observer),
    timeline: () => renderTimeline(impl.diagnostics),
  };
}
