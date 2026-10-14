/**
 * Public entry point for the DOT kernel (v2).
 *
 * `defineApp(name)` returns a `DotAppBuilder` that accumulates units in three
 * hexagonal steps, then transitions through the 5-hook lifecycle:
 *
 *   defineApp -> use* -> features? -> serve* -> configure() -> boot() -> start() -> stop() -> dispose()
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

import type { DotDiagnosticsSnapshot } from './diagnostics.js';
import type { DotLifecycleObserver } from './lifecycle-observer.js';
import type { DotLifecycleState } from './lifecycle.js';
import type { DotAppManifest } from './manifest.js';
import type { AnyFeature, Driven, Driver, PluginsOf } from './feature.js';
import type { AnyPlugin, EmptyShape, Plugin, ServiceRecord } from './plugin-contract.js';
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
  readonly 'DOT: this unit provides a key that an earlier unit already provides. Give one of them a new key with rename()': keyof TAvail & keyof TProvides;
};

/**
 * A plugin whose `boot` always throws infers `TProvides = never`, which would
 * poison both the collision check (`keyof never` matches everything) and
 * the accumulated record (`TAvail & never` = `never`). Such a plugin provides
 * nothing — normalize to the empty shape.
 */
export type NormalizeProvides<TP extends ServiceRecord> = [TP] extends [never] ? EmptyShape : TP;

/**
 * Rest-tuple guard. Satisfied → `[]` (call `.use(plugin)` with one argument).
 * Violated → a required second argument of an unconstructible error type,
 * so the call site fails with the diagnostic embedded in the expected type.
 */
export type UseGuard<
  TAvail extends ServiceRecord,
  TNeeds extends ServiceRecord,
  TProvides extends ServiceRecord,
> = [TAvail] extends [TNeeds]
  ? [keyof TAvail & keyof TProvides] extends [never]
    ? []
    : [error: CollisionError<TAvail, TProvides>]
  : [error: NeedsError<TAvail, TNeeds>];

type UseAllState<TAvail extends ServiceRecord, TPlugins extends readonly AnyPlugin[]> = TPlugins extends readonly [
  infer Head,
  ...infer Tail,
]
  ? Head extends Plugin<infer TNeeds, infer TProvides>
    ? UseGuard<TAvail, TNeeds, NormalizeProvides<TProvides>> extends []
      ? UseAllState<TAvail & NormalizeProvides<TProvides>, Extract<Tail, readonly AnyPlugin[]>>
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
          readonly 'DOT: this list accepts only plugins': Head;
        };
      }
  : {
      readonly avail: TAvail;
      readonly error: never;
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
    adapter: Plugin<TNeeds, TProvides> | Driver<TNeeds, TProvides>,
    ...guard: UseGuard<TAvail, TNeeds, NormalizeProvides<TProvides>>
  ): DotServeBuilder<TAvail & NormalizeProvides<TProvides>>;
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
    plugin: Plugin<TNeeds, TProvides> | Driven<TNeeds, TProvides>,
    ...guard: UseGuard<TAvail, TNeeds, NormalizeProvides<TProvides>>
  ): DotAppBuilder<TAvail & NormalizeProvides<TProvides>>;
  /**
   * Register a tuple of plugins in declaration order. This is type-equivalent
   * to calling `.use()` for each item and keeps the same ordering/collision
   * guard across the whole tuple.
   */
  useAll<const TPlugins extends readonly AnyPlugin[]>(
    plugins: TPlugins,
    ...guard: UseAllGuard<TAvail, TPlugins>
  ): DotAppBuilder<UseAllAvail<TAvail, TPlugins>>;
  /**
   * Mount the domain features, in order. A feature may need what earlier
   * features provide. Called once: after it, only `.serve()` remains.
   */
  features<const TFeatures extends readonly AnyFeature[]>(
    features: TFeatures,
    ...guard: UseAllGuard<TAvail, Extract<PluginsOf<TFeatures>, readonly AnyPlugin[]>>
  ): DotServeBuilder<UseAllAvail<TAvail, Extract<PluginsOf<TFeatures>, readonly AnyPlugin[]>>>;
} & Pick<DotServeBuilder<TAvail>, 'serve'>;

type BuilderState = {
  appName: string;
  appVersion?: string;
  /** A `Driven` is bound to the final feature list at build time. */
  plugins: (AnyPlugin | Driven)[];
  /** The features mounted by `.features()` — what drivers are bound to. */
  features: readonly AnyFeature[];
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
     * fails with `DOT_LIFECYCLE_E015` naming the plugin and hook, and the
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

function makeBuilder<TAvail extends ServiceRecord>(state: BuilderState): DotAppBuilder<TAvail> {
  // The `use` implementation is signature-erased (the guard exists purely
  // at the type level); the single cast below is the same kernel boundary
  // v1 crossed in its wrapApp helper. The phase split is type-only too:
  // one runtime object serves every phase.
  const impl = {
    features(features: readonly AnyFeature[], ..._guard: readonly unknown[]): DotAppBuilder<ServiceRecord> {
      const nextState: BuilderState = {
        ...state,
        plugins: [...state.plugins, ...features.map((f): AnyPlugin => ({ ...(plug(f) as AnyPlugin), role: 'feature' }))],
        features: [...state.features, ...features],
      };
      return makeBuilder<ServiceRecord>(nextState);
    },
    serve(adapter: AnyPlugin | Driver, ..._guard: readonly unknown[]): DotAppBuilder<ServiceRecord> {
      const bound: AnyPlugin = 'bind' in adapter ? bindDriver(adapter, state.features) : adapter;
      const nextState: BuilderState = {
        ...state,
        plugins: [...state.plugins, { ...bound, role: 'driving' }],
      };
      return makeBuilder<ServiceRecord>(nextState);
    },
    use(plugin: AnyPlugin | Driven, ..._guard: readonly unknown[]): DotAppBuilder<ServiceRecord> {
      const nextState: BuilderState = {
        ...state,
        plugins: [...state.plugins, plugin],
      };
      return makeBuilder<ServiceRecord>(nextState);
    },
    useAll(plugins: readonly AnyPlugin[], ..._guard: readonly unknown[]): DotAppBuilder<ServiceRecord> {
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
