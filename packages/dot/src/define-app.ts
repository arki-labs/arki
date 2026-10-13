/**
 * Public entry point for the DOT kernel (v2).
 *
 * `defineApp(name)` returns a `DotAppBuilder` that accumulates plugins via
 * `.use(plugin)`, then transitions through the 5-hook lifecycle:
 *
 *   defineApp -> use* -> configure() -> boot() -> start() -> stop() -> dispose()
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
import type { AnyPlugin, EmptyShape, Plugin, ServiceRecord } from './plugin-contract.js';
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
  readonly 'DOT: plugin needs services no earlier .use() provides': {
    readonly missing: MissingKeys<TAvail, TNeeds>;
    readonly mismatched: MismatchedKeys<TAvail, TNeeds>;
  };
};

type CollisionError<TAvail, TProvides> = {
  readonly 'DOT: plugin provides wire keys already provided (use rename())': keyof TAvail & keyof TProvides;
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
            readonly 'DOT: useAll tuple contains a plugin that cannot be used at this position': UseGuard<
              TAvail,
              TNeeds,
              NormalizeProvides<TProvides>
            >[0];
          };
        }
    : {
        readonly avail: TAvail;
        readonly error: {
          readonly 'DOT: useAll accepts only plugins': Head;
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
        readonly 'DOT: useAll requires a tuple; add `as const` or pass plugins directly in declaration order': TPlugins;
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

/**
 * Builder produced by `defineApp(name)`.
 *
 * `.use(plugin)` is type-tracking in both directions: the plugin's `needs` must
 * be satisfied by the services accumulated so far, and its `provides`
 * merge into the accumulated record for the next `.use()`.
 */
export type DotAppBuilder<TAvail extends ServiceRecord> = {
  /**
   * Register a plugin. Compile error when the plugin's needs are unsatisfied
   * or its provides collide with existing wire keys.
   */
  use<TNeeds extends ServiceRecord, TProvides extends ServiceRecord>(
    plugin: Plugin<TNeeds, TProvides>,
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
  /** Run the configure phase synchronously. Throws on configure failure. */
  configure(): DotAppConfigured<TAvail>;
  /** Run configure + boot. Throws on configure or boot failure. */
  boot(): Promise<DotApp<TAvail>>;
  /** Convenience: configure + boot + start. */
  start(): Promise<DotApp<TAvail>>;
};

type BuilderState = {
  appName: string;
  appVersion?: string;
  plugins: AnyPlugin[];
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
    plugins: state.plugins,
    config: state.config,
    observers: state.observers,
    hookTimeoutMs: state.hookTimeoutMs,
  });
}

function makeBuilder<TAvail extends ServiceRecord>(state: BuilderState): DotAppBuilder<TAvail> {
  // The `use` implementation is signature-erased (the guard exists purely
  // at the type level); the single cast below is the same kernel boundary
  // v1 crossed in its wrapApp helper.
  const impl = {
    use(plugin: AnyPlugin, ..._guard: readonly unknown[]): DotAppBuilder<ServiceRecord> {
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
