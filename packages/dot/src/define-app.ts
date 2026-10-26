import type { Clock } from '@arki/clock';
import type { Failure, FailureIn } from '@arki/failure';
import { isFailure, UnexpectedDefect } from '@arki/failure';

/**
 * Public entry point for the DOT kernel (v2).
 *
 * `defineApp(name)` returns a `DotAppBuilder` that accumulates units in three
 * hexagonal steps, then transitions through the 5-hook lifecycle:
 *
 *   defineApp(name).infra(...).features([...]).entrypoints(...)
 *     -> configure() -> boot() -> start() -> stop() -> dispose()
 *
 * Each step is compile-time guarded: a unit whose `needs` are not satisfied
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
import type { EntrypointBinder, InfraBinder } from './feature.js';
import type {
  DotBootOutcome,
  DotConfigureOutcome,
  DotDisposeOutcome,
  DotStartedOutcome,
  DotStartOutcome,
  DotStopOutcome,
} from './kernel/app-instance.js';
import type { DotLifecycleObserver } from './lifecycle-observer.js';
import type { DotLifecycleState } from './lifecycle.js';
import { DotLifecycleError, DotLifecycleErrorCode } from './lifecycle.js';
import type { DotAppManifest } from './manifest.js';
import type {
  AnyUnit,
  EmptyPhases,
  EmptyShape,
  MergePhases,
  RuntimeUnit,
  ServiceRecord,
  UnitCloseFailure,
  UnitOpenFailure,
  UnitPhaseFailures,
  UnitPhases,
  UnitRole,
  UnitSourceGuard,
  UnitWiring,
} from './unit-contract.js';
import type { MaxIndex, NextIndex } from './tuple-index.js';
import { allFeatures, mountFeatures } from './define-feature.js';
import { bindEntrypoint } from './feature.js';
import { DotAppImpl } from './kernel/app-instance.js';
import { renderTimeline } from './timeline.js';

function failed<Value>(value: Value): value is FailureIn<Value> {
  return isFailure<unknown>(value);
}

function configuredApp<
  Services extends ServiceRecord,
  Open extends Failure,
  Close extends Failure,
  Phases extends UnitPhases,
>(
  value: DotAppConfigured<Services, Open, Close, Phases> | Failure,
): value is DotAppConfigured<Services, Open, Close, Phases> {
  return !isFailure<unknown>(value);
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
  readonly 'DOT: this unit needs services that nothing before it provides. Mount their providers earlier (.infra → .features → .entrypoints)': {
    readonly missing: MissingKeys<TAvail, TNeeds>;
    readonly mismatched: MismatchedKeys<TAvail, TNeeds>;
  };
};

type CollisionError<TAvail, TProvides> = {
  readonly 'DOT: this unit provides a key that an earlier unit already provides. Give one of them a new key with rename()': keyof TAvail &
    keyof TProvides;
};

/**
 * A unit whose `boot` always throws infers `TProvides = never`, which would
 * poison both the collision check (`keyof never` matches everything) and
 * the accumulated record (`TAvail & never` = `never`). Such a unit provides
 * nothing — normalize to the empty shape.
 */
export type NormalizeProvides<TP extends ServiceRecord> = [TP] extends [never] ? EmptyShape : TP;

/**
 * One unit's wiring check. Satisfied → `[]`; violated → `[error]` with the
 * diagnostic as the error type. `ListGuard` turns it into a type on the
 * argument itself, so the call site fails on the unit with the `DOT:`
 * label in the message (not with "Expected 2 arguments, but got 1").
 * The open record (`DotAppBuilder<ServiceRecord>`, the erased builder a
 * runtime-built unit list gives) has nothing to check: the kernel checks
 * it at boot.
 */
export type UseGuard<
  TAvail extends ServiceRecord,
  TNeeds extends ServiceRecord,
  TProvides extends ServiceRecord,
  TUnit = EmptyShape,
> =
  UnitSourceGuard<TUnit> extends []
    ? string extends keyof TAvail
      ? []
      : [TAvail] extends [TNeeds]
        ? [keyof TAvail & keyof TProvides] extends [never]
          ? []
          : [error: CollisionError<TAvail, TProvides>]
        : [error: NeedsError<TAvail, TNeeds>]
    : UnitSourceGuard<TUnit>;

/*
 * The list checks walk the tuple by index (`NextIndex`, see tuple-index.ts):
 * `TUnits[I]` is one lookup, where `[infer Head, ...infer Tail]` would
 * re-slice the list at every step. A list longer than the table is refused
 * with a label.
 */

/**
 * Entry to the walk. The `[...infer All]` match is one copy of the tuple, and
 * it is what ends the walk for a GENERIC list: there `All` is its constraint
 * (`readonly AnyUnit[]`), `0 extends number` holds, and the walk stops at
 * step 0 instead of expanding `NextIndex` forever while TypeScript computes
 * the conditional's constraint.
 */
type UseAllState<TAvail extends ServiceRecord, TUnits extends readonly AnyUnit[]> = TUnits extends readonly [
  ...infer All extends readonly AnyUnit[],
]
  ? UseAllWalk<TAvail, All, 0>
  : { readonly avail: TAvail; readonly error: never };

type UseAllWalk<
  TAvail extends ServiceRecord,
  TUnits extends readonly AnyUnit[],
  I extends number,
> = I extends TUnits['length']
  ? { readonly avail: TAvail; readonly error: never }
  : I extends MaxIndex
    ? {
        readonly avail: TAvail;
        readonly error: { readonly 'DOT: a list may hold at most this many units': MaxIndex };
      }
    : UseGuard<
          TAvail,
          UnitWiring<TUnits[I]>['needs'],
          NormalizeProvides<UnitWiring<TUnits[I]>['provides']>,
          TUnits[I]
        > extends []
      ? UseAllWalk<TAvail & NormalizeProvides<UnitWiring<TUnits[I]>['provides']>, TUnits, NextIndex[I]>
      : {
          readonly avail: TAvail;
          readonly error: {
            readonly 'DOT: a unit in this list cannot be mounted at its position': UseGuard<
              TAvail,
              UnitWiring<TUnits[I]>['needs'],
              NormalizeProvides<UnitWiring<TUnits[I]>['provides']>,
              TUnits[I]
            >[0];
          };
        };

export type UseAllAvail<TAvail extends ServiceRecord, TUnits extends readonly AnyUnit[]> = UseAllState<
  TAvail,
  TUnits
>['avail'];

type UseAllTupleGuard<TUnits extends readonly AnyUnit[]> = number extends TUnits['length']
  ? [
      error: {
        readonly 'DOT: pass a tuple. Add `as const`, or list the units inline in boot order': TUnits;
      },
    ]
  : [];

export type UseAllGuard<TAvail extends ServiceRecord, TUnits extends readonly AnyUnit[]> = [
  UseAllState<TAvail, TUnits>['error'],
] extends [never]
  ? UseAllTupleGuard<TUnits>
  : [error: UseAllState<TAvail, TUnits>['error']];

/**
 * `UseAllGuard` as a rest-parameter check: `unknown` when the list mounts,
 * otherwise the error record — intersected with the argument tuple, so the
 * call fails with the diagnostic in the expected type.
 */
export type ListGuard<TGuard extends readonly unknown[]> = TGuard extends readonly [error: infer TError]
  ? TError
  : unknown;

/** The names (or positions) of the units in a list whose role a step refuses. */
type RefusedUnits<TUnits extends readonly unknown[], TRefused extends UnitRole> = {
  readonly [K in keyof TUnits]: TUnits[K] extends { readonly role: TRefused }
    ? TUnits[K] extends { readonly name: infer N extends string }
      ? N
      : never
    : never;
}[number];

/** The positions of bare `unit()` values in a list: they carry no role, so no step may mount them. */
type BareUnits<TUnits extends readonly unknown[]> = {
  readonly [K in keyof TUnits]: TUnits[K] extends { readonly role?: undefined; readonly name: infer N extends string }
    ? N
    : never;
}[number];

/**
 * A step's role check, as a rest-parameter intersection like {@link ListGuard}:
 * `unknown` when every unit belongs on this side, else a `DOT:` record naming
 * the offenders. `.infra()` refuses entrypoints; `.entrypoints()` refuses infra
 * and feature units; neither mounts a bare `unit()`. Erased units (`AnyUnit`)
 * pass here and are checked at configure time (`ARKI_DOT_E033`).
 */
export type SideGuard<TUnits extends readonly unknown[], TRefused extends UnitRole> = [
  RefusedUnits<TUnits, TRefused>,
] extends [never]
  ? [BareUnits<TUnits>] extends [never]
    ? unknown
    : {
        readonly 'DOT: a bare unit() has no role. Write infra({...}) or entrypoint({...})': BareUnits<TUnits>;
      }
  : [TRefused] extends ['entrypoint']
    ? { readonly 'DOT: an entrypoint cannot be mounted as infra. Mount it with .entrypoints(...)': RefusedUnits<TUnits, TRefused> }
    : {
        readonly 'DOT: only entrypoints mount here. Mount infra with .infra(...) and features with .features([...])': RefusedUnits<
          TUnits,
          TRefused
        >;
      };

/** A list of units and adapters, each seen as the unit it mounts (an adapter's `bind` result). */
type AsUnits<TUnits extends readonly unknown[]> = {
  readonly [K in keyof TUnits]: TUnits[K] extends { readonly bind: (features: never) => infer TUnit }
    ? TUnit
    : TUnits[K];
};

/** The kernel units one feature mounts: its `units()`. */
type UnitsOfFeature<TFeature> = TFeature extends { units(): infer TUnits extends readonly AnyUnit[] } ? TUnits : never;

/** Index walk (see `NextIndex` / `UseAllState`): `[infer Head, ...infer Tail]` would re-slice the list at every feature. */
type FlattenUnits<TFeatures extends readonly unknown[]> = TFeatures extends readonly [
  ...infer All extends readonly unknown[],
]
  ? FlattenWalk<All, 0, readonly []>
  : readonly AnyUnit[];
type FlattenWalk<
  TFeatures extends readonly unknown[],
  I extends number,
  TAcc extends readonly AnyUnit[],
> = I extends TFeatures['length']
  ? TAcc
  : I extends MaxIndex
    ? readonly AnyUnit[]
    : FlattenWalk<TFeatures, NextIndex[I], readonly [...TAcc, ...UnitsOfFeature<TFeatures[I]>]>;

/**
 * Every kernel unit a feature list mounts, flattened in order — what
 * `.features()` checks with the `UseAllGuard`. A non-tuple list stays an
 * array, so the guard asks for a tuple.
 */
export type FeatureUnits<TFeatures extends readonly AnyDefinedFeature[]> = number extends TFeatures['length']
  ? readonly AnyUnit[]
  : FlattenUnits<TFeatures>;

/* ------------------------------------------------------------------ */
/* Public app surface                                                  */
/* ------------------------------------------------------------------ */

/**
 * Public DotApp surface. The internal `DotAppImpl` implements this; consumers
 * see only these members.
 */
export type DotApp<
  TServices extends ServiceRecord,
  TClose extends Failure = never,
  _TOpen extends Failure = never,
  TPhases extends UnitPhases = EmptyPhases,
> = {
  /** App name (passed to `defineApp`). */
  readonly name: string;
  /** Current lifecycle state. */
  readonly state: DotLifecycleState;
  /**
   * Services published by booted units, keyed by wire key.
   * Empty before `boot()` succeeds.
   */
  readonly services: TServices;
  /** Declarative manifest — describes the static shape of the app. */
  readonly manifest: DotAppManifest;
  /** Point-in-time diagnostics snapshot. Re-computed on every access. */
  readonly diagnostics: DotDiagnosticsSnapshot;
  /**
   * Start active work. Boots first if app is `defined` or `configured`.
   * Idempotent while `started`. Returns a defect if the app is `failed` or `disposed`.
   */
  start(): Promise<DotStartedOutcome<TClose, TPhases>>;
  /**
   * Stop active work. Keeps booted resources for later cleanup.
   * Idempotent while not `started`.
   */
  stop(): Promise<DotStopOutcome<TPhases>>;
  /**
   * Release booted resources. Runs stop() first if `started`.
   * Idempotent while `disposed`.
   */
  dispose(): Promise<DotDisposeOutcome<TClose, TPhases>>;
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
  TPhases extends UnitPhases = EmptyPhases,
> = {
  readonly name: string;
  readonly state: DotLifecycleState;
  readonly manifest: DotAppManifest;
  readonly diagnostics: DotDiagnosticsSnapshot;
  /** Continue the lifecycle. */
  boot(): Promise<DotApp<TServices, TClose, TOpen, TPhases> | Exclude<DotBootOutcome<TOpen, TClose, TPhases>, void>>;
  start(): Promise<DotApp<TServices, TClose, TOpen, TPhases> | Exclude<DotStartOutcome<TOpen, TClose, TPhases>, void>>;
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
  TPhases extends UnitPhases = EmptyPhases,
> = Pick<Builder<TAvail, TOpen, TClose, TPhases>, 'configure' | 'boot' | 'start'>;

/**
 * Builder after `.features()` — only `.entrypoints()` remains.
 * Infra cannot follow the domain: infrastructure never depends on a feature.
 */
export type DotServeBuilder<
  TAvail extends ServiceRecord,
  TOpen extends Failure = never,
  TClose extends Failure = never,
  TPhases extends UnitPhases = EmptyPhases,
> = Pick<
  Builder<TAvail, TOpen, TClose, TPhases>,
  keyof DotAppLifecycle<TAvail, TOpen, TClose, TPhases> | 'entrypoints'
>;

/**
 * Builder produced by `defineApp(name)`. The app reads as a hexagon:
 *
 *   .infra(...)       what features need (db, kv, queue client)
 *   .features([...])  the domain core
 *   .entrypoints(...) what calls the features (http, workers)
 *
 * Each step is type-tracking in both directions: a unit's `needs` must be
 * satisfied by the services accumulated so far, and its `provides` merge
 * into the accumulated record for the next step.
 */
export type DotAppBuilder<
  TAvail extends ServiceRecord,
  TOpen extends Failure = never,
  TClose extends Failure = never,
  TPhases extends UnitPhases = EmptyPhases,
> = Pick<Builder<TAvail, TOpen, TClose, TPhases>, keyof Builder<TAvail, TOpen, TClose, TPhases>>;

type BuilderState<
  TOpen extends Failure = never,
  TClose extends Failure = never,
  TPhases extends UnitPhases = EmptyPhases,
> = {
  appName: string;
  appVersion?: string;
  /** An `InfraBinder` is bound to the final feature list at build time. */
  plugins: (
    | RuntimeUnit<TOpen, TClose, TPhases>
    | InfraBinder<ServiceRecord, ServiceRecord, { open: TOpen; close: TClose }, TPhases>
  )[];
  /** The features mounted by `.features()`, as written — what entrypoints are bound to. */
  features: readonly AnyDefinedFeature[];
  /** Units mounted on the wrong side, in an erased graph the types could not check. `configure()` refuses the app. */
  misplaced: readonly MisplacedUnit[];
  config?: Readonly<Record<string, unknown>>;
  observers?: readonly DotLifecycleObserver[];
  hookTimeoutMs?: number;
  clock?: Clock;
};

/**
 * Create a new DOT app builder.
 *
 * @example
 * const app = await defineApp('pizzeria')
 *   .infra(database, cache)   // cache's needs must be satisfied by database
 *   .features([billing])
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
     * fails with `ARKI_DOT_E015` naming the unit and hook, and the
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
    misplaced: [],
    config: options.config,
    observers: options.observers,
    hookTimeoutMs: options.hookTimeoutMs,
    clock: options.clock,
  };
  return makeBuilder<EmptyShape>(state);
}

function buildImpl<TOpen extends Failure, TClose extends Failure, TPhases extends UnitPhases>(
  state: BuilderState<TOpen, TClose, TPhases>,
): DotAppImpl<TOpen, TClose, TPhases> {
  const [misplaced] = state.misplaced;
  if (misplaced !== undefined) {
    throw new DotLifecycleError({
      code: DotLifecycleErrorCode.UnitOnWrongSide,
      phase: 'configure',
      plugin: misplaced.name,
      message: `Unit "${misplaced.name}" is an ${misplaced.role} unit, mounted with .${misplaced.step}()`,
    });
  }
  return new DotAppImpl({
    appName: state.appName,
    appVersion: state.appVersion,
    // A unit built by `fromFeatures` takes its binder's role: the binder is the declaration.
    plugins: state.plugins.map(unit => ('bind' in unit ? { ...unit.bind(state.features), role: unit.role } : unit)),
    config: state.config,
    observers: state.observers,
    hookTimeoutMs: state.hookTimeoutMs,
    clock: state.clock,
  });
}

function bindAdapter(adapter: AnyUnit | EntrypointBinder, features: readonly AnyDefinedFeature[]): AnyUnit {
  // A unit built by `fromFeatures` takes its binder's role, so an `infra.fromFeatures` here is caught as misplaced.
  return 'bind' in adapter ? { ...bindEntrypoint(adapter, features), role: adapter.role } : onSide(adapter, 'entrypoint');
}

/** A builder step and the role it gives a unit that has none. */
type Step = { readonly name: 'infra'; readonly role: 'infra' } | { readonly name: 'entrypoints'; readonly role: 'entrypoint' };

/** A unit an erased graph mounted on the wrong side; `configure()` refuses the app with `ARKI_DOT_E033`. */
type MisplacedUnit = { readonly name: string; readonly role: UnitRole; readonly step: Step['name'] };

/** Give a role-less unit the step's role; a unit built by `infra` / `entrypoint` / `defineFeature` keeps its own. */
function onSide<const U extends AnyUnit>(unit: U, role: UnitRole): U {
  return unit.role === undefined ? { ...unit, role } : unit;
}

/** Infra steps take infra, feature and domain-service units; entrypoint steps take entrypoints only. */
function misplacedIn(units: readonly (AnyUnit | EntrypointBinder | InfraBinder)[], step: Step): readonly MisplacedUnit[] {
  return units.flatMap(unit => {
    const role = unit.role;
    if (
      role === undefined ||
      role === step.role ||
      (step.role === 'infra' && (role === 'feature' || role === 'domain-service'))
    )
      return [];
    return [{ name: unit.name, role, step: step.name }];
  });
}

/** Runtime lists retain the checked construct/close objects from their source units. */
function runtimeUnits<const Units extends readonly (AnyUnit | InfraBinder)[]>(
  units: Units,
): readonly (
  | RuntimeUnit<
      UnitOpenFailure<AsUnits<Units>[number]>,
      UnitCloseFailure<AsUnits<Units>[number]>,
      UnitPhaseFailures<AsUnits<Units>[number]>
    >
  | InfraBinder<
      ServiceRecord,
      ServiceRecord,
      { open: UnitOpenFailure<AsUnits<Units>[number]>; close: UnitCloseFailure<AsUnits<Units>[number]> },
      UnitPhaseFailures<AsUnits<Units>[number]>
    >
)[];
function runtimeUnits(units: readonly (AnyUnit | InfraBinder)[]): readonly (AnyUnit | InfraBinder)[] {
  return units;
}
function featureRuntime<const Features extends readonly AnyDefinedFeature[]>(
  features: Features,
): readonly RuntimeUnit<
  UnitOpenFailure<FeatureUnits<Features>[number]>,
  UnitCloseFailure<FeatureUnits<Features>[number]>,
  UnitPhaseFailures<FeatureUnits<Features>[number]>
>[];
function featureRuntime(features: readonly AnyDefinedFeature[]): readonly AnyUnit[] {
  mountFeatures(features);
  return features.flatMap(f => f.units());
}
function drivingRuntime<const Adapters extends readonly (AnyUnit | EntrypointBinder)[]>(
  adapters: Adapters,
  features: readonly AnyDefinedFeature[],
): readonly RuntimeUnit<
  UnitOpenFailure<AsUnits<Adapters>[number]>,
  UnitCloseFailure<AsUnits<Adapters>[number]>,
  UnitPhaseFailures<AsUnits<Adapters>[number]>
>[];
function drivingRuntime(
  adapters: readonly (AnyUnit | EntrypointBinder)[],
  features: readonly AnyDefinedFeature[],
): readonly AnyUnit[] {
  return adapters.map(adapter => bindAdapter(adapter, features));
}

/** Internal dynamic-list entrypoint; unlike `.infra(...list)`, this does not claim tuple wiring checks. */
export function mountUnits<
  Open extends Failure,
  Close extends Failure,
  Services extends ServiceRecord = ServiceRecord,
  Phases extends UnitPhases = EmptyPhases,
>(
  name: string,
  plugins: readonly RuntimeUnit<Open, Close, Phases>[],
  options: Parameters<typeof defineApp>[1] = {},
): DotAppBuilder<Services, Open, Close, Phases> {
  return makeBuilder<Services, Open, Close, Phases>({
    appName: name,
    appVersion: options.version,
    plugins: [...plugins],
    features: [],
    misplaced: [],
    config: options.config,
    observers: options.observers,
    hookTimeoutMs: options.hookTimeoutMs,
    clock: options.clock,
  });
}

function makeBuilder<
  TAvail extends ServiceRecord,
  TOpen extends Failure = never,
  TClose extends Failure = never,
  TPhases extends UnitPhases = EmptyPhases,
>(state: BuilderState<TOpen, TClose, TPhases>): DotAppBuilder<TAvail, TOpen, TClose, TPhases> {
  return new Builder<TAvail, TOpen, TClose, TPhases>(state);
}

/** One checked implementation supplies both public builder phases. */
class Builder<
  TAvail extends ServiceRecord,
  TOpen extends Failure,
  TClose extends Failure,
  TPhases extends UnitPhases,
> {
  readonly #state: BuilderState<TOpen, TClose, TPhases>;

  constructor(state: BuilderState<TOpen, TClose, TPhases>) {
    this.#state = state;

    this.infra = this.infra.bind(this);
    this.features = this.features.bind(this);
    this.entrypoints = this.entrypoints.bind(this);
    this.configure = this.configure.bind(this);
    this.boot = this.boot.bind(this);
    this.start = this.start.bind(this);
  }

  private append<Avail extends ServiceRecord, Open extends Failure, Close extends Failure, Phases extends UnitPhases>(
    units: readonly (
      RuntimeUnit<Open, Close, Phases> | InfraBinder<ServiceRecord, ServiceRecord, { open: Open; close: Close }, Phases>
    )[],
    features = this.#state.features,
    step?: Step,
  ): Builder<Avail, TOpen | Open, TClose | Close, MergePhases<TPhases, Phases>> {
    return new Builder<Avail, TOpen | Open, TClose | Close, MergePhases<TPhases, Phases>>({
      ...this.#state,
      plugins: [...this.#state.plugins, ...(step === undefined ? units : units.map(u => ('bind' in u ? u : onSide(u, step.role))))],
      features,
      misplaced: step === undefined ? this.#state.misplaced : [...this.#state.misplaced, ...misplacedIn(units, step)],
    });
  }

  /** Register infrastructure in boot order, before the domain. */
  infra<const Units extends readonly (AnyUnit | InfraBinder)[]>(
    ...units: Units & SideGuard<Units, 'entrypoint'> & ListGuard<UseAllGuard<TAvail, Extract<AsUnits<Units>, readonly AnyUnit[]>>>
  ): DotAppBuilder<
    UseAllAvail<TAvail, Extract<AsUnits<Units>, readonly AnyUnit[]>>,
    TOpen | UnitOpenFailure<AsUnits<Units>[number]>,
    TClose | UnitCloseFailure<AsUnits<Units>[number]>,
    MergePhases<TPhases, UnitPhaseFailures<AsUnits<Units>[number]>>
  > {
    return this.append<
      UseAllAvail<TAvail, Extract<AsUnits<Units>, readonly AnyUnit[]>>,
      UnitOpenFailure<AsUnits<Units>[number]>,
      UnitCloseFailure<AsUnits<Units>[number]>,
      UnitPhaseFailures<AsUnits<Units>[number]>
    >(runtimeUnits<Units>(units), undefined, { name: 'infra', role: 'infra' });
  }

  /** Mount the domain; later steps can register only driving adapters. */
  features<const Features extends readonly AnyDefinedFeature[]>(
    features: Features & ListGuard<UseAllGuard<TAvail, Extract<FeatureUnits<Features>, readonly AnyUnit[]>>>,
  ): DotServeBuilder<
    UseAllAvail<TAvail, Extract<FeatureUnits<Features>, readonly AnyUnit[]>>,
    TOpen | UnitOpenFailure<FeatureUnits<Features>[number]>,
    TClose | UnitCloseFailure<FeatureUnits<Features>[number]>,
    MergePhases<TPhases, UnitPhaseFailures<FeatureUnits<Features>[number]>>
  > {
    return this.append<
      UseAllAvail<TAvail, Extract<FeatureUnits<Features>, readonly AnyUnit[]>>,
      UnitOpenFailure<FeatureUnits<Features>[number]>,
      UnitCloseFailure<FeatureUnits<Features>[number]>,
      UnitPhaseFailures<FeatureUnits<Features>[number]>
    >(featureRuntime<Features>(features), [...this.#state.features, ...allFeatures(features)]);
  }

  /** Register the app's driving adapters in argument order. */
  entrypoints<const Adapters extends readonly (AnyUnit | EntrypointBinder)[]>(
    ...adapters: Adapters &
      SideGuard<Adapters, 'infra' | 'feature'> &
      ListGuard<UseAllGuard<TAvail, Extract<AsUnits<Adapters>, readonly AnyUnit[]>>>
  ): DotServeBuilder<
    UseAllAvail<TAvail, Extract<AsUnits<Adapters>, readonly AnyUnit[]>>,
    TOpen | UnitOpenFailure<AsUnits<Adapters>[number]>,
    TClose | UnitCloseFailure<AsUnits<Adapters>[number]>,
    MergePhases<TPhases, UnitPhaseFailures<AsUnits<Adapters>[number]>>
  > {
    return this.append<
      UseAllAvail<TAvail, Extract<AsUnits<Adapters>, readonly AnyUnit[]>>,
      UnitOpenFailure<AsUnits<Adapters>[number]>,
      UnitCloseFailure<AsUnits<Adapters>[number]>,
      UnitPhaseFailures<AsUnits<Adapters>[number]>
    >(drivingRuntime<Adapters>(adapters, this.#state.features), undefined, { name: 'entrypoints', role: 'entrypoint' });
  }

  configure(): DotAppConfigured<TAvail, TOpen, TClose, TPhases> | Exclude<DotConfigureOutcome<TPhases>, void> {
    try {
      const impl = buildImpl(this.#state);
      const outcome = impl.runConfigure();
      if (failed(outcome)) return outcome;
      return wrapConfigured<TAvail, TOpen, TClose, TPhases>(impl);
    } catch (error) {
      return UnexpectedDefect({ cause: error });
    }
  }

  async boot(): Promise<
    | DotApp<TAvail, TClose, TOpen, TPhases>
    | Exclude<DotConfigureOutcome<TPhases> | DotBootOutcome<TOpen, TClose, TPhases>, void>
  > {
    const configured = this.configure();
    if (!configuredApp(configured)) return configured;
    return configured.boot();
  }

  async start(): Promise<
    | DotApp<TAvail, TClose, TOpen, TPhases>
    | Exclude<DotConfigureOutcome<TPhases> | DotStartOutcome<TOpen, TClose, TPhases>, void>
  > {
    const configured = this.configure();
    if (!configuredApp(configured)) return configured;
    return configured.start();
  }
}

function wrapApp<
  TServices extends ServiceRecord,
  TOpen extends Failure,
  TClose extends Failure,
  TPhases extends UnitPhases,
>(impl: DotAppImpl<TOpen, TClose, TPhases>): DotApp<TServices, TClose, TOpen, TPhases> {
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
    start: () => impl.startBooted(),
    stop: () => impl.stop(),
    dispose: () => impl.dispose(),
    subscribe: observer => impl.subscribe(observer),
    timeline: () => renderTimeline(impl.diagnostics),
  };
}

function wrapConfigured<
  TServices extends ServiceRecord,
  TOpen extends Failure,
  TClose extends Failure,
  TPhases extends UnitPhases,
>(impl: DotAppImpl<TOpen, TClose, TPhases>): DotAppConfigured<TServices, TOpen, TClose, TPhases> {
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
      const result = await impl.bootConfigured();
      if (failed(result)) return result;
      return wrapApp<TServices, TOpen, TClose, TPhases>(impl);
    },
    async start() {
      const result = await impl.startConfigured();
      if (failed(result)) return result;
      return wrapApp<TServices, TOpen, TClose, TPhases>(impl);
    },
    subscribe: observer => impl.subscribe(observer),
    timeline: () => renderTimeline(impl.diagnostics),
  };
}
