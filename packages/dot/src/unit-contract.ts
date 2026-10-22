/**
 * Public unit contract for the DOT kernel (v2).
 *
 * A unit declares what it **needs** as a shape of type witnesses and
 * what it **provides** as one factory per published key. The keys are
 * static, so `unit.provides` holds a typed handle per key before
 * anything boots. The kernel wires services by key, injects them into
 * hook contexts under the unit's local aliases, and fails loudly (coded
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
 *    through individual unit failures, reporting an aggregate error.
 */

import type { CheckedPlan, ScopeAggregate, ScopeOptions, ScopePlan, SupervisorFailure } from '@arki/async';
import type { Failure, FailureIn, FailureOf, SuccessOf } from '@arki/failure';
import { createLifetime, isScopeEntry } from '@arki/async';
import { isFailure, UnexpectedDefect } from '@arki/failure';

import type { AnyDefinedFeature } from './define-feature.js';
import type { Lazy } from './lazy.js';
import type { DotHandlerTransport } from './lifecycle-observer.js';
import type { ActionManifest, JsonObject, ProjectionManifest, ServiceKind } from './manifest.js';
import type { DotTelemetry } from './telemetry.js';
import { isLazy } from './lazy.js';

declare const TypeOf: unique symbol;

/**
 * Phantom type witness for a service. Carries `T` at the type level only —
 * the runtime value is an empty object.
 */
export type Service<out T> = { readonly [TypeOf]?: T };

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
 * const reports = infra({
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

type WitnessContext<Witness> = [Witness] extends [LazyService<infer Value>]
  ? Lazy<Value>
  : [Witness] extends [Service<infer Value>]
    ? Value
    : never;

/**
 * Local-alias view of a needs shape — what lifecycle hooks destructure.
 * `{ cache: Token<KV, 'arki.kv'> }` → `{ cache: KV }`.
 * `{ search: service.lazy<S>() }` → `{ search: Lazy<S> }`.
 */
export type CtxOf<S extends NeedsShape> = { [K in keyof S]: WitnessContext<S[K]> };

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
 * erased units).
 */
export type NoReservedKeys = Readonly<Record<`$${string}`, never>>;

/** Identity of one handler call, as a transport adapter names it. */
export type DotHandlerRef = { readonly transport: DotHandlerTransport; readonly name: string };

/** The kernel context key that carries {@link DotHandlerObserver}; a feature's services bag keeps it for adapters. */
export const HANDLERS_KEY = '$handlers';

/** How a transport reads its own outcomes, where Dot's default rule does not fit it. */
export type DotHandlerOutcome = {
  /**
   * Which throws are refusals: an object means `completed/refused` (the error is
   * still rethrown); `undefined` means `failed`. Default: every throw is `failed`.
   */
  readonly thrown?: (error: unknown) => { readonly failure?: Failure } | undefined;
  /**
   * The Failure a returned (settled) value stands for, if any: `completed/refused`
   * when there is one. Default: the value itself when it is a Failure.
   */
  readonly returned?: (value: unknown) => Failure | undefined;
};

/** What a transport adapter calls around one handler to make its lifecycle events. */
export type DotHandlerObserver = {
  /**
   * Whether any observer listens right now. Observers can be added after boot,
   * so ask per call; a hot path uses it to skip building what it would hand to `run`.
   */
  readonly watching: () => boolean;
  /**
   * Run one handler call: emits `starting`, then `completed` or `failed`. Returns
   * `run()`'s value unchanged: a promise is observed, not wrapped. `outcome`
   * overrides how a throw or a returned value is read (see {@link DotHandlerOutcome}).
   */
  readonly run: <T>(ref: DotHandlerRef, run: () => T, outcome?: DotHandlerOutcome) => T;
};

/**
 * Kernel-supplied context keys, present in every service-carrying hook
 * context. The `$` prefix is a reserved namespace: `infra()` rejects
 * `$`-prefixed needs aliases and publish keys at compile time (via
 * {@link NoReservedKeys}) and the kernel enforces it at runtime
 * (`ARKI_DOT_E014`), so these keys can never be shadowed.
 */
export type KernelCtx = {
  /** App name (passed to `defineApp`). */
  readonly $app: string;
  /** This unit's name. */
  readonly $unit: string;
  /** Custom spans, events, metrics and correlated logs scoped to this mounted unit or feature. */
  readonly $telemetry: DotTelemetry;
  /** Handler lifecycle events for transport adapters (rpc, http, job, schedule): see {@link DotHandlerObserver}. */
  readonly $handlers: DotHandlerObserver;
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
   * Complete an action's `summary` once the unit's services exist (a
   * `provides` factory, `boot`, `start`, ...). `dot explain` stays static;
   * the post-boot `app.manifest` and `dot doctor` show the new text.
   *
   * A unit may amend an action it declared, or an action in a binding it
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
  /** Custom telemetry scoped to this unit, sharing its active configure span. */
  readonly $telemetry: DotTelemetry;
  unitName: string;
  /** App name. */
  appName: string;
  /**
   * Register a service this unit publishes, for manifest/diagnostics
   * purposes. Registration is metadata-only — the actual service instance
   * is returned from its `provides` factory.
   */
  registerService(name: string, kind: ServiceKind): void;
  /** Register an action this unit contributes at an app boundary. */
  registerAction(action: ActionDeclaration): void;
  /** Register a projection renderer this unit contributes. */
  registerProjection(projection: ProjectionDeclaration): void;
  /**
   * Replace the `summary` of an action already registered. Same ownership
   * rule as `$describeAction` (see {@link KernelCtx}); in `configure` it sees
   * the actions of units mounted earlier.
   */
  describeAction(actionId: string, patch: { readonly summary: string }): void;
  /** @deprecated Use `registerAction`; removed in DOT 0.5.0. */
  registerRoute(route: LegacyRouteDeclaration): void;
  /** Mark the unit as participating in a lifecycle hook. */
  registerLifecycleHook(hook: 'configure' | 'boot' | 'start' | 'stop' | 'dispose'): void;
  /** Append `provides` capability strings (informational, manifest-only). */
  declareProvides(...capabilities: string[]): void;
};

type MaybePromise<T> = T | Promise<T>;

/** What the kernel passes to a unit's `logging` factory. */
export type DotLoggingContext = {
  /** App name (passed to `defineApp`). */
  readonly appName: string;
};

/** What a `logging` factory returns. The kernel closes it after the app's last lifecycle record. */
export type DotLoggingHandle<Close extends undefined | Failure = undefined | Failure> = {
  close(): MaybePromise<Close>;
};

/** The actual logging callback remains the source of activation and cleanup failures.
 * @example type Slot = LoggingSlot<DotLoggingHandle>;
 */
export type LoggingSlot<Result extends DotLoggingHandle | Failure> = {
  readonly logging?: (ctx: DotLoggingContext) => Result;
};

/** An authored unit's `boot` callback, which keeps the outcome it was written with.
 * A named type on purpose: a package's emitted `.d.ts` names it instead of writing
 * the member out, which would add `| undefined` and break apps that turn on
 * `exactOptionalPropertyTypes`.
 * @example type Slot = BootSlot<KernelCtx, undefined>;
 */
export type BootSlot<Ctx, Boot> = {
  readonly boot?: (ctx: Ctx) => MaybePromise<Boot>;
};

/**
 * A capability handle: a token on the wire key `K`, stamped with the name
 * of the unit that provides it. `infra()` and `defineFeature()` mint one per
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

/** One handle per published key — what `unit.provides` holds. */
export type Handles<TProvides extends ServiceRecord, O extends string = string> = {
  readonly [K in keyof TProvides as K & string]: Handle<TProvides[K], K & string, O>;
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

/** Exact failures owned by a unit's construction and release callbacks. */
export type UnitOwnership = { readonly open: Failure; readonly close: Failure };
/** A unit with no declared construction or cleanup refusals.
 * @example type OpenFailure = EmptyOwnership['open']; // never
 */
export type EmptyOwnership = { readonly open: never; readonly close: never };
type CallbackFailure<Value, Key extends PropertyKey> =
  Value extends Record<Key, infer Callback extends (...args: never[]) => unknown> ? FailureOf<Callback> : never;
type EntriesFailure<Values, Key extends PropertyKey> = Values extends unknown
  ? CallbackFailure<Values[keyof Values], Key>
  : never;
/** Consumer-visible successful value of an ordinary or owned provider. */
type ResourceEntry = Extract<ScopePlan[string], { kind: 'resource' }>;
export type ProvidedValue<Value> = Value extends ResourceEntry | Failure
  ? Value extends ResourceEntry
    ? Value extends { readonly open: infer Open extends (...args: never[]) => unknown }
      ? SuccessOf<Open>
      : never
    : never
  : Value;
export type ProvidedValues<Values> = { [Name in keyof Values]: ProvidedValue<Awaited<Values[Name]>> };
type ProviderValues<Values> = Values extends unknown ? Awaited<Values[keyof Values]> : never;
type ProviderEntries<Values> = Extract<ProviderValues<Values>, ResourceEntry>;
type ProviderOpen<Values> = Extract<ProviderValues<Values>, Failure> | CallbackFailure<ProviderEntries<Values>, 'open'>;
type LazyClose<Value> = Value extends Lazy<unknown, Failure> ? FailureOf<Value['dispose']> : never;
type ProviderClose<Values> =
  | CallbackFailure<ProviderEntries<Values>, 'close'>
  | LazyClose<Exclude<ProviderValues<Values>, ResourceEntry | Failure>>;
export type InferredOwnership<in out Values, out Boot> = {
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
/** Failures owned by the runtime's feature preparation, independent of replaceable callbacks.
 * @example type Prepared = UnitPreparation<typeof database>;
 */
export type UnitPreparation<P> = P extends { readonly [OwnershipSym]?: infer Owned extends UnitOwnership }
  ? Owned
  : EmptyOwnership;
type FactoryValue<Factory> = Factory extends (...args: never[]) => infer Value ? Value : never;
type FactoryValues<Factories> = { [Key in keyof Factories]: FactoryValue<Factories[Key]> };
type SourceOwnership<P> = P extends { readonly factories: infer Factories; readonly hooks: infer Hooks }
  ? InferredOwnership<
      FactoryValues<Factories>,
      Hooks extends { readonly boot?: (...args: never[]) => infer Boot } ? Awaited<Boot> : never
    >
  : EmptyOwnership;
type LoggingResult<P> = P extends { readonly logging?: (...args: never[]) => infer Result } ? Result : never;
export type UnitOpenFailure<P> =
  UnitPreparation<P>['open'] | SourceOwnership<P>['open'] | Extract<LoggingResult<P>, Failure>;
export type UnitCloseFailure<P> =
  UnitPreparation<P>['close'] | SourceOwnership<P>['close'] | CallbackFailure<LoggingResult<P>, 'close'>;
export type UnitCloseOutcome<Close extends Failure> =
  void | Close | SupervisorFailure | ScopeAggregate<Close | SupervisorFailure, Close | SupervisorFailure>;
export type UnitBootOutcome<Open extends Failure, Close extends Failure> =
  void | Open | Close | SupervisorFailure | ScopeAggregate<Open | Close | SupervisorFailure, Close | SupervisorFailure>;
/** A successfully constructed unit lifetime, transferred unchanged to its app. */
export type UnitConstruction<Close extends Failure> = {
  readonly services: ServiceRecord;
  quiesce(): Promise<UnitCloseOutcome<Close>>;
  close(): Promise<UnitCloseOutcome<Close>>;
};
/**
 * Constraint for the four lifecycle failure channels; infer concrete channels from a unit.
 * @example type Phases = UnitPhaseFailures<typeof database>;
 */
export type UnitPhases = {
  readonly configure: Failure;
  readonly start: Failure;
  readonly stop: Failure;
  readonly dispose: Failure;
};
/** No declared hook failures.
 * @example type ConfigureFailure = EmptyPhases['configure']; // never
 */
export type EmptyPhases = { readonly [Phase in keyof UnitPhases]: never };
export type HookReturns = { readonly [Phase in keyof UnitPhases]: undefined | Failure };
export type EmptyHookReturns = { readonly [Phase in keyof UnitPhases]: undefined };
/** Derive phase failures from callback results.
 * @example type Phases = InferredPhases<{ configure: undefined; start: undefined; stop: undefined; dispose: undefined }>;
 */
export type InferredPhases<Returns extends HookReturns> = {
  readonly [Phase in keyof UnitPhases]: Extract<Returns[Phase], Failure>;
};
/** Combine failure channels when appending a unit to an app.
 * @example type Phases = MergePhases<UnitPhaseFailures<typeof database>, UnitPhaseFailures<typeof server>>;
 */
export type MergePhases<Left extends UnitPhases, Right extends UnitPhases> = {
  readonly [Phase in keyof UnitPhases]: Left[Phase] | Right[Phase];
};
type HookFailure<Hook> = Hook extends (...args: never[]) => infer Result ? Extract<Awaited<Result>, Failure> : never;
type PhaseFailure<Hooks, Phase extends keyof UnitPhases> = Hooks extends unknown
  ? Phase extends keyof Hooks
    ? HookFailure<Hooks[Phase]>
    : never
  : never;
/** Infer each phase from the actual hooks, including spread replacements.
 * @example type StartFailure = UnitPhaseFailures<typeof server>['start'];
 */
export type UnitPhaseFailures<P> = P extends { readonly hooks: infer Hooks }
  ? { readonly [Phase in keyof UnitPhases]: PhaseFailure<Hooks, Phase> }
  : EmptyPhases;
/** Lifecycle callbacks sharing a context, with concrete results per phase.
 * @example type Hooks = PhaseHooks<EmptyShape, EmptyHookReturns>;
 */
export type PhaseHooks<Context, Returns extends HookReturns> = {
  readonly configure?: (ctx: DotConfigureContext) => Returns['configure'];
  readonly start?: (ctx: Context) => MaybePromise<Returns['start']>;
  readonly stop?: (ctx: Context) => MaybePromise<Returns['stop']>;
  readonly dispose?: (ctx: Context) => MaybePromise<Returns['dispose']>;
};
export type UnitRuntime<out Open extends Failure, out Close extends Failure> = {
  construct<Values, Boot>(
    factories: { readonly [Key in keyof Values]: (ctx: never) => Values[Key] },
    boot: ((ctx: never) => Boot) | undefined,
    ctx: never,
    options: ScopeOptions,
    claimLazy: (value: Lazy<unknown, Failure>) => boolean,
  ): Promise<
    | UnitConstruction<Close | InferredOwnership<Values, Awaited<Boot>>['close']>
    | Exclude<
        UnitBootOutcome<
          Open | InferredOwnership<Values, Awaited<Boot>>['open'],
          Close | InferredOwnership<Values, Awaited<Boot>>['close']
        >,
        void
      >
  >;
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
  : void extends Value
    ? never
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
type PlainValue = PlainService | string | number | boolean | bigint | symbol | null | undefined;
export type CheckedProvider<Value> = PlainValue | PromiseLike<PlainValue> | CheckedOutput<Awaited<Value>>;

/**
 * Infer raw factory returns once, including Promise wrappers. Explicit
 * TProvides annotations describe those raw returns, not the resolved services.
 * Services and ownership resolve promises through their shared projections.
 */
export type ProvidesFactories<TNeeds extends NeedsShape, TProvides extends ServiceRecord> = {
  readonly [K in keyof TProvides]: (
    services: CtxOf<TNeeds> & KernelCtx,
  ) => TProvides[K] & NoInfer<CheckedProvider<TProvides[K]>>;
};

/** An erased factory record — what the kernel runs at boot. */
export type AnyFactories = Readonly<Record<string, (ctx: never) => unknown>>;

declare const NeedsSym: unique symbol;
declare const ProvidesSym: unique symbol;
declare const ProviderIdentitySym: unique symbol;
declare const OwnershipSym: unique symbol;

/**
 * The DOT unit (v2). Author through {@link unit} — never construct directly.
 *
 * Hook signatures are type-erased here (`ctx: never`): the typed view
 * lives on `infra()`'s parameter, and `(ctx: Typed) => R` is assignable to
 * `(ctx: never) => R` without casts (parameter contravariance from the
 * bottom type). The kernel crosses the erasure boundary at the call site.
 *
 * The phantom symbol properties carry `TNeeds` / `TProvides` for the app
 * builder's compile-time wiring check, and `TShape` (the `needs` record as
 * written: alias → witness) so the feature builder can read WHICH handle a
 * need names — its `provider` and `key` literals — not only the service type.
 * `Unit<N, P>` without a shape means "unknown"; the checks that read it
 * fall back to the wire-key rules. They never exist at runtime. `TOwner` is
 * the unit's name as a literal — the `provider` its handles carry.
 */
/** See {@link Unit.role}. */
export type UnitRole = 'infra' | 'feature' | 'domain-service' | 'entrypoint';

export type Unit<
  out TNeeds extends ServiceRecord = ServiceRecord,
  out TProvides extends ServiceRecord = ServiceRecord,
  out TShape extends NeedsShape = NeedsShape,
  out TOwner extends string = string,
  out TOwnership extends UnitOwnership = EmptyOwnership,
  out TPhases extends UnitPhases = EmptyPhases,
> = {
  readonly runtime: UnitRuntime<TOwnership['open'], TOwnership['close']>;
  readonly [OwnershipSym]?: TOwnership;
  /** Unique identifier for this unit within the app. */
  readonly name: string;
  /** Runtime needs shape (local alias → witness). */
  readonly needs: NeedsShape;
  readonly actions: readonly ActionSource[];
  /** Mount-time renames: publish key → new wire key (see {@link rename}). */
  readonly renames: Readonly<Record<string, string>>;
  /**
   * The unit's place in the hexagon, set by its constructor: `infra`
   * ({@link infra}, mounted with `.infra()`), `feature` (compiled by
   * `defineFeature`, mounted with `.features()`) or `entrypoint`
   * ({@link entrypoint}, mounted with `.entrypoints()`). A bare {@link unit}
   * has none until a role constructor or a builder step gives it one.
   */
  readonly role?: UnitRole;
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
   * The logging slot. At most one unit per app fills it. The kernel activates
   * it during boot, before provider construction, and closes it after owned
   * unit cleanup. Configure never activates logging.
   */
  readonly logging?: (ctx: DotLoggingContext) => DotLoggingHandle<undefined | TOwnership['close']> | TOwnership['open'];
  readonly hooks: PhaseHooks<never, { readonly [Phase in keyof UnitPhases]: undefined | TPhases[Phase] }> & {
    readonly boot?: (ctx: never) => unknown;
  };
  readonly [NeedsSym]?: TNeeds;
  readonly [ProvidesSym]?: TProvides;
  readonly [ProviderIdentitySym]?: TShape;
};

declare const FactoryContractSym: unique symbol;
/** The successful outputs that minted a unit's handles; failures stay inferred from the live callbacks.
 * @example type Contract = FactoryContract<{ count: number }>;
 */
export type FactoryContract<Values extends ServiceRecord> = { readonly [FactoryContractSym]?: Values };
/** Preserve the original factory contract while projecting a unit's wiring.
 * @example type Contract = FactoryContractOf<typeof database>;
 */
export type FactoryContractOf<P> = FactoryContract<P extends FactoryContract<infer Values> ? Values : never>;
type MatchingFactoryShape<Factories, Expected> = Expected extends unknown
  ? [Exclude<keyof Factories, keyof Expected> | Exclude<keyof Expected, keyof Factories>] extends [never]
    ? Expected
    : never
  : never;
type FactoryShapeError<Factories, Expected> = Factories extends unknown
  ? [MatchingFactoryShape<Factories, Expected>] extends [never]
    ? { readonly 'DOT: replacement factories must preserve the original factory keys': keyof Expected }
    : ProvidedValues<FactoryValues<Factories>> extends MatchingFactoryShape<Factories, Expected>
      ? never
      : { readonly 'DOT: replacement factories must preserve the services carried by the original handles': Expected }
  : never;
type FactoryContractError<P> =
  P extends FactoryContract<infer Expected>
    ? [Expected] extends [never]
      ? never
      : P extends { readonly factories: infer Factories }
        ? FactoryShapeError<Factories, Expected>
        : never
    : never;
/** Validate replaceable factories against the handles their original definitions minted.
 * @example type Guard = UnitFactoryGuard<typeof database>;
 */
export type UnitFactoryGuard<P> = [FactoryContractError<P>] extends [never] ? [] : [error: FactoryContractError<P>];

type BootReturnError<P, Boot> =
  void extends Awaited<Boot>
    ? Failure extends UnitOpenFailure<P>
      ? never
      : { readonly 'DOT: boot must retain concrete returns, including undefined instead of void': Boot }
    : Awaited<Boot> extends undefined | ScopePlan | Failure
      ? BootGuard<Awaited<Boot>> extends [error: infer Error]
        ? Error
        : never
      : { readonly 'DOT: boot must return undefined, a typed failure or an owned plan': Boot };
type HooksBootError<P, Hooks> = Hooks extends unknown
  ? 'boot' extends keyof Hooks
    ? BootReturnError<P, ReturnType<Extract<Hooks['boot'], (...args: never[]) => unknown>>>
    : never
  : never;
type SourceBootError<P> = P extends { readonly hooks: infer Hooks } ? HooksBootError<P, Hooks> : never;
/** Validate the live factories and boot callback before mounting a unit.
 * @example type MountGuard = UnitSourceGuard<typeof database>;
 */
export type UnitSourceGuard<P> = [FactoryContractError<P> | SourceBootError<P>] extends [never]
  ? []
  : [error: FactoryContractError<P> | SourceBootError<P>];

/** Authored units retain the callbacks that own their runtime failures.
 * @example const database = infra({ name: 'db', provides: { count: () => 0 } }); // AuthoredUnit is inferred.
 */
export type AuthoredUnit<
  Needs extends ServiceRecord,
  Provides extends ServiceRecord,
  Shape extends NeedsShape,
  Owner extends string,
  Values extends ServiceRecord,
  Phases extends UnitPhases,
  Logging extends DotLoggingHandle | Failure,
  Boot,
> = Omit<Unit<Needs, Provides, Shape, Owner, EmptyOwnership, Phases>, 'logging' | 'factories' | 'hooks'> &
  LoggingSlot<Logging> &
  FactoryContract<ProvidedValues<Values>> & {
    readonly factories: { readonly [Key in keyof Values]: (ctx: never) => Values[Key] };
    readonly hooks: PhaseHooks<never, { readonly [Phase in keyof UnitPhases]: undefined | Phases[Phase] }> &
      BootSlot<CtxOf<Shape> & Provides & KernelCtx, Boot>;
  };

/** Wiring metadata for a unit whose unit contract was already checked. */
export type UnitWiring<P extends AnyUnit> = {
  readonly needs: NonNullable<P[typeof NeedsSym]>;
  readonly provides: NonNullable<P[typeof ProvidesSym]>;
};

/** Extract a unit's (wire-keyed) needs record. */
export type UnitNeeds<P> = P extends AnyUnit ? NonNullable<P[typeof NeedsSym]> : never;
/** Extract a unit's (wire-keyed) provides record. */
export type UnitProvides<P> = P extends AnyUnit ? NonNullable<P[typeof ProvidesSym]> : never;
/**
 * Extract a unit's needs as written (alias → witness). A handle witness
 * carries the identity of the service it names (`provider` + `key`); an
 * anonymous `service<T>()` carries none. `NeedsShape` (every key, every
 * witness) when the unit was typed without a shape — "unknown".
 */
export type UnitProviderIdentities<P> = P extends AnyUnit ? NonNullable<P[typeof ProviderIdentitySym]> : NeedsShape;
/** The `provider` literal a unit's handles carry (`string` when the unit was typed without its name). */
export type UnitOwner<P> =
  P extends Unit<ServiceRecord, ServiceRecord, NeedsShape, infer O, UnitOwnership, UnitPhases> ? O : string;

/** Internal type alias used by the kernel to erase unit service generics. */
export type AnyUnit = Unit<ServiceRecord, ServiceRecord, NeedsShape, string, UnitOwnership, UnitPhases>;
/** A scheduled unit whose closed execution operations retain exact phase outcomes. */
// A named interface compares failure channels without repeatedly expanding the erased unit members.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export interface RuntimeUnit<
  out Open extends Failure,
  out Close extends Failure,
  out Phases extends UnitPhases = EmptyPhases,
> extends Omit<AnyUnit, 'runtime' | 'hooks' | 'logging'> {
  readonly runtime: UnitRuntime<Open, Close>;
  readonly logging?: (ctx: DotLoggingContext) => DotLoggingHandle<undefined | Close> | Open;
  readonly hooks: Unit<ServiceRecord, ServiceRecord, NeedsShape, string, UnitOwnership, Phases>['hooks'];
}

/**
 * Author a DOT unit.
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
 * - `start` / `stop` / `dispose` additionally receive the unit's own
 *   provides. Reverse-order teardown guarantees needs are still alive in
 *   `dispose`.
 *
 * @example
 * ```ts
 * export const billing = infra({
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
export type UnitDefinition<
  TShape extends NeedsShape,
  TProvides extends ServiceRecord,
  TName extends string,
  TBoot,
  Returns extends HookReturns = EmptyHookReturns,
  Logging extends DotLoggingHandle | Failure = DotLoggingHandle<undefined>,
> = PhaseHooks<CtxOf<TShape> & ProvidedValues<TProvides> & KernelCtx, Returns> & {
  readonly name: TName;
  readonly needs?: TShape;
  readonly actions?: readonly ActionSource[];
  /** Fill the logging slot (see {@link Unit.logging}). Called by the kernel, never at import. */
  readonly logging?: (ctx: DotLoggingContext) => Logging;
  /** One factory per published key. Each gets the needs + kernel keys. Keys are the publish keys. */
  readonly provides?: ProvidesFactories<TShape, TProvides>;
  /** Runs after the factories; may return a typed private ownership plan or failure. */
  readonly boot?: (ctx: CtxOf<TShape> & ProvidedValues<NoInfer<TProvides>> & KernelCtx) => MaybePromise<TBoot>;
};

/** A unit whose hooks return nothing: what the first constructor overload builds. */
export type PlainAuthoredUnit<
  TShape extends NeedsShape,
  TProvides extends ServiceRecord,
  TName extends string,
  TBoot,
> = AuthoredUnit<
  WireNeeds<TShape>,
  ProvidedValues<TProvides>,
  TShape,
  TName,
  TProvides,
  EmptyPhases,
  DotLoggingHandle<undefined>,
  TBoot
>;

/** A unit whose hooks may return typed failures: what the second constructor overload builds. */
export type PhasedAuthoredUnit<
  TShape extends NeedsShape,
  TProvides extends ServiceRecord,
  TName extends string,
  TBoot,
  TConfigure extends undefined | Failure,
  TStart extends undefined | Failure,
  TStop extends undefined | Failure,
  TDispose extends undefined | Failure,
  TLogging extends DotLoggingHandle | Failure,
> = AuthoredUnit<
  WireNeeds<TShape>,
  ProvidedValues<TProvides>,
  TShape,
  TName,
  TProvides,
  InferredPhases<{ configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose }>,
  TLogging,
  TBoot
>;

/** What `infra()` stamps on its unit: the builder's `.infra()` accepts it, `.entrypoints()` refuses it. */
export type InfraRole = { readonly role: 'infra' };
/** What `entrypoint()` stamps on its unit: `.entrypoints()` accepts it, `.infra()` refuses it. */
export type EntrypointRole = { readonly role: 'entrypoint' };
/** A bare `unit()` has no role; no builder step mounts it until `fromFeatures` gives it one. */
export type NoRole = { readonly role?: undefined };

/**
 * A unit built from the app's mounted features — `infra.fromFeatures(features => unit({...}))`
 * or `entrypoint.fromFeatures(features => unit({...}))`. The builder calls `bind` with the
 * final feature list when the app is built, so a unit can derive its static
 * `actions` from the features' declarations before anything boots.
 */
export type UnitBinder<TRole extends 'infra' | 'entrypoint', U extends AnyUnit = AnyUnit> = {
  readonly role: TRole;
  readonly bind: (features: readonly AnyDefinedFeature[]) => U;
};

/** Infrastructure built from the mounted features' declarations (the journal reads their handlers). It boots before them. */
export type InfraBinder<
  TNeeds extends ServiceRecord = ServiceRecord,
  TProvides extends ServiceRecord = ServiceRecord,
  TOwnership extends UnitOwnership = UnitOwnership,
  TPhases extends UnitPhases = UnitPhases,
> = UnitBinder<'infra', Unit<TNeeds, TProvides, NeedsShape, string, TOwnership, TPhases>>;

/** An entrypoint built from the mounted features (an HTTP server serving their routes). It boots after them. */
export type EntrypointBinder<
  TNeeds extends ServiceRecord = ServiceRecord,
  TProvides extends ServiceRecord = ServiceRecord,
  TOwnership extends UnitOwnership = UnitOwnership,
  TPhases extends UnitPhases = UnitPhases,
> = UnitBinder<'entrypoint', Unit<TNeeds, TProvides, NeedsShape, string, TOwnership, TPhases>>;

// The first overload of each constructor supplies concrete undefined context without accepting erased void callbacks.

/**
 * The kernel atom with no role: a typed box of `needs`, `provides` and
 * lifecycle hooks. Use it only inside `fromFeatures` —
 * `entrypoint.fromFeatures(features => unit({...}))` — where the outer
 * constructor gives the role. Everywhere else write {@link infra} or {@link entrypoint}.
 */
export function unit<
  TShape extends NeedsShape & NoReservedKeys = EmptyShape,
  TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
  const TName extends string = string,
  TBoot extends undefined = undefined,
>(
  def: UnitDefinition<TShape, TProvides, TName, undefined, EmptyHookReturns, DotLoggingHandle<undefined>>,
  ..._guard: BootGuard<NoInfer<TBoot>>
): PlainAuthoredUnit<TShape, TProvides, TName, TBoot> & NoRole;
export function unit<
  TShape extends NeedsShape & NoReservedKeys = EmptyShape,
  TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
  const TName extends string = string,
  TBoot extends undefined | ScopePlan | Failure = undefined,
  TConfigure extends undefined | Failure = undefined,
  TStart extends undefined | Failure = undefined,
  TStop extends undefined | Failure = undefined,
  TDispose extends undefined | Failure = undefined,
  TLogging extends DotLoggingHandle | Failure = DotLoggingHandle<undefined>,
>(
  def: UnitDefinition<
    TShape,
    TProvides,
    TName,
    TBoot,
    { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
    TLogging
  >,
  ..._guard: BootGuard<NoInfer<TBoot>>
): PhasedAuthoredUnit<TShape, TProvides, TName, TBoot, TConfigure, TStart, TStop, TDispose, TLogging> & NoRole;
export function unit<
  TShape extends NeedsShape & NoReservedKeys = EmptyShape,
  TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
  const TName extends string = string,
  TBoot extends undefined | ScopePlan | Failure = undefined,
  TConfigure extends undefined | Failure = undefined,
  TStart extends undefined | Failure = undefined,
  TStop extends undefined | Failure = undefined,
  TDispose extends undefined | Failure = undefined,
  TLogging extends DotLoggingHandle | Failure = DotLoggingHandle<undefined>,
>(
  def: UnitDefinition<
    TShape,
    TProvides,
    TName,
    TBoot,
    { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
    TLogging
  >,
  ..._guard: BootGuard<NoInfer<TBoot>>
): PhasedAuthoredUnit<TShape, TProvides, TName, TBoot, TConfigure, TStart, TStop, TDispose, TLogging> {
  return createUnit<TShape, TProvides, TName, TBoot, TConfigure, TStart, TStop, TDispose, TLogging>(def);
}

/**
 * Infrastructure the app or a feature runs on: a database, a cache, a mailer,
 * an outside client. Mount it with `.infra(...)`. It boots before the
 * features and never depends on them.
 *
 * {@link infra.fromFeatures} builds it from the mounted features' declarations.
 */
export function infra<
  TShape extends NeedsShape & NoReservedKeys = EmptyShape,
  TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
  const TName extends string = string,
  TBoot extends undefined = undefined,
>(
  def: UnitDefinition<TShape, TProvides, TName, undefined, EmptyHookReturns, DotLoggingHandle<undefined>>,
  ..._guard: BootGuard<NoInfer<TBoot>>
): PlainAuthoredUnit<TShape, TProvides, TName, TBoot> & InfraRole;
export function infra<
  TShape extends NeedsShape & NoReservedKeys = EmptyShape,
  TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
  const TName extends string = string,
  TBoot extends undefined | ScopePlan | Failure = undefined,
  TConfigure extends undefined | Failure = undefined,
  TStart extends undefined | Failure = undefined,
  TStop extends undefined | Failure = undefined,
  TDispose extends undefined | Failure = undefined,
  TLogging extends DotLoggingHandle | Failure = DotLoggingHandle<undefined>,
>(
  def: UnitDefinition<
    TShape,
    TProvides,
    TName,
    TBoot,
    { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
    TLogging
  >,
  ..._guard: BootGuard<NoInfer<TBoot>>
): PhasedAuthoredUnit<TShape, TProvides, TName, TBoot, TConfigure, TStart, TStop, TDispose, TLogging> & InfraRole;
export function infra(def: AnyUnitDefinition): AnyUnit {
  return { ...createUnit(def), role: 'infra' };
}

/**
 * Infrastructure built from the mounted features' declarations — the journal
 * composes their handlers this way. The builder calls `bind` with the final
 * feature list; the unit boots before the features and sees only what they
 * declare, never their slice records.
 *
 * A separate name, not an overload: an overload that takes a function makes
 * TypeScript type a definition's hooks against it first and keep that type.
 */
infra.fromFeatures = function infraFromFeatures<const U extends AnyUnit>(
  bind: (features: readonly AnyDefinedFeature[]) => U,
): UnitBinder<'infra', U> {
  return { role: 'infra', bind };
};

/**
 * What calls into the features: an HTTP server, a job worker, a scheduler.
 * Mount it with `.entrypoints(...)`. It boots after the features.
 *
 * {@link entrypoint.fromFeatures} builds it from the mounted features (their
 * routes, jobs or schedules).
 */
export function entrypoint<
  TShape extends NeedsShape & NoReservedKeys = EmptyShape,
  TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
  const TName extends string = string,
  TBoot extends undefined = undefined,
>(
  def: UnitDefinition<TShape, TProvides, TName, undefined, EmptyHookReturns, DotLoggingHandle<undefined>>,
  ..._guard: BootGuard<NoInfer<TBoot>>
): PlainAuthoredUnit<TShape, TProvides, TName, TBoot> & EntrypointRole;
export function entrypoint<
  TShape extends NeedsShape & NoReservedKeys = EmptyShape,
  TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
  const TName extends string = string,
  TBoot extends undefined | ScopePlan | Failure = undefined,
  TConfigure extends undefined | Failure = undefined,
  TStart extends undefined | Failure = undefined,
  TStop extends undefined | Failure = undefined,
  TDispose extends undefined | Failure = undefined,
  TLogging extends DotLoggingHandle | Failure = DotLoggingHandle<undefined>,
>(
  def: UnitDefinition<
    TShape,
    TProvides,
    TName,
    TBoot,
    { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
    TLogging
  >,
  ..._guard: BootGuard<NoInfer<TBoot>>
): PhasedAuthoredUnit<TShape, TProvides, TName, TBoot, TConfigure, TStart, TStop, TDispose, TLogging> & EntrypointRole;
export function entrypoint(def: AnyUnitDefinition): AnyUnit {
  return { ...createUnit(def), role: 'entrypoint' };
}

/**
 * An entrypoint built from the mounted features: an HTTP server serving
 * their routes, a worker running their jobs. The builder calls `bind` with
 * the final feature list, so the unit can derive its static `actions` from
 * the features' declarations before anything boots.
 */
entrypoint.fromFeatures = function entrypointFromFeatures<const U extends AnyUnit>(
  bind: (features: readonly AnyDefinedFeature[]) => U,
): UnitBinder<'entrypoint', U> {
  return { role: 'entrypoint', bind };
};

/** The erased definition the role constructors' implementations accept; each overload above checks the real one. */
type AnyUnitDefinition = UnitDefinition<
  NeedsShape & NoReservedKeys,
  ServiceRecord & NoReservedKeys,
  string,
  undefined | ScopePlan | Failure,
  HookReturns,
  DotLoggingHandle | Failure
>;


/** Shared constructor after each authoring surface has checked its provider returns. */
export function createUnit<
  TShape extends NeedsShape & NoReservedKeys,
  TProvides extends ServiceRecord & NoReservedKeys,
  const TName extends string,
  TBoot extends undefined = undefined,
>(
  def: UnitDefinition<TShape, TProvides, TName, undefined, EmptyHookReturns, DotLoggingHandle<undefined>>,
): AuthoredUnit<
  WireNeeds<TShape>,
  ProvidedValues<TProvides>,
  TShape,
  TName,
  TProvides,
  EmptyPhases,
  DotLoggingHandle<undefined>,
  TBoot
>;
export function createUnit<
  TShape extends NeedsShape & NoReservedKeys,
  TProvides extends ServiceRecord & NoReservedKeys,
  const TName extends string,
  TBoot extends undefined | ScopePlan | Failure = undefined,
  TConfigure extends undefined | Failure = undefined,
  TStart extends undefined | Failure = undefined,
  TStop extends undefined | Failure = undefined,
  TDispose extends undefined | Failure = undefined,
  TLogging extends DotLoggingHandle | Failure = DotLoggingHandle<undefined>,
>(
  def: UnitDefinition<
    TShape,
    TProvides,
    TName,
    TBoot,
    { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
    TLogging
  >,
): AuthoredUnit<
  WireNeeds<TShape>,
  ProvidedValues<TProvides>,
  TShape,
  TName,
  TProvides,
  InferredPhases<{ configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose }>,
  TLogging,
  TBoot
>;
export function createUnit<
  TShape extends NeedsShape & NoReservedKeys,
  TProvides extends ServiceRecord & NoReservedKeys,
  const TName extends string,
  TBoot extends undefined | ScopePlan | Failure = undefined,
  TConfigure extends undefined | Failure = undefined,
  TStart extends undefined | Failure = undefined,
  TStop extends undefined | Failure = undefined,
  TDispose extends undefined | Failure = undefined,
  TLogging extends DotLoggingHandle | Failure = DotLoggingHandle<undefined>,
>(
  def: UnitDefinition<
    TShape,
    TProvides,
    TName,
    TBoot,
    { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
    TLogging
  >,
): AuthoredUnit<
  WireNeeds<TShape>,
  ProvidedValues<TProvides>,
  TShape,
  TName,
  TProvides,
  InferredPhases<{ configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose }>,
  TLogging,
  TBoot
> {
  const factories = factoriesOf(def.provides);
  const handles: Record<string, AnyHandle> = {};
  for (const key of Object.keys(factories)) handles[key] = handleOf(key, def.name);
  const runtime = createUnitRuntime();
  return {
    name: def.name,
    needs: def.needs ?? {},
    actions: def.actions ?? [],
    renames: {},
    // Erasure seam: the record is built by key at runtime; its type comes
    // from the factory returns that `infra()` inferred, its `provider` from `name`.
    provides: handles as Handles<ProvidedValues<TProvides>, TName>,
    runtime,
    factories,
    ...(def.logging === undefined ? {} : { logging: def.logging }),
    hooks: {
      ...createPhaseHooks<{ configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose }>(def),
      ...(def.boot === undefined ? {} : { boot: def.boot }),
    },
  };
}

/** The absent factory record is the empty authored record. */
function factoriesOf<Values>(factories: { readonly [Key in keyof Values]: (ctx: never) => Values[Key] } | undefined): {
  readonly [Key in keyof Values]: (ctx: never) => Values[Key];
};
function factoriesOf(factories: AnyFactories | undefined): AnyFactories {
  return factories ?? {};
}

/** Preserve callback identity while projecting the exhaustive undefined-or-failure authoring domain. */
function createPhaseHooks<Returns extends HookReturns>(
  hooks: PhaseHooks<never, Returns>,
): PhaseHooks<never, { readonly [Phase in keyof UnitPhases]: undefined | InferredPhases<Returns>[Phase] }>;
function createPhaseHooks(hooks: PhaseHooks<never, HookReturns>): PhaseHooks<never, HookReturns> {
  return {
    ...(hooks.configure === undefined ? {} : { configure: hooks.configure }),
    ...(hooks.start === undefined ? {} : { start: hooks.start }),
    ...(hooks.stop === undefined ? {} : { stop: hooks.stop }),
    ...(hooks.dispose === undefined ? {} : { dispose: hooks.dispose }),
  };
}

function failed<Value>(value: Value): value is FailureIn<Value> {
  return isFailure<unknown>(value);
}

export function createUnitRuntime<Prepared extends object | void = void>(
  project?: (services: ServiceRecord, ctx: never) => void,
  prepare?: (ctx: never) => MaybePromise<Prepared>,
): UnitRuntime<Extract<Awaited<Prepared>, Failure>, never>;
export function createUnitRuntime(
  project?: (services: ServiceRecord, ctx: never) => void,
  prepare?: (ctx: never) => MaybePromise<object | void>,
): UnitRuntime<Failure, Failure> {
  return {
    async construct(
      factories: AnyFactories,
      boot: ((ctx: never) => unknown) | undefined,
      ctx: Record<string, unknown>,
      options,
      claimLazy,
    ) {
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
        if (prepare !== undefined) {
          const prepared = await lifetime.acquire(async () => {
            const value = await prepare(context as never);
            if (failed(value)) return value;
            return { value, close: () => Promise.resolve() };
          });
          if (failed(prepared)) lifetime.fail(prepared);
          else if (prepared !== undefined) Object.assign(context, prepared);
        }
        for (const [key, factory] of Object.entries(factories)) {
          if (lifetime.signal.aborted || lifetime.hasFailure()) break;
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
                } else if (value.kind === 'cleanup') {
                  // eslint-disable-next-line failure/must-use -- close() owns cleanup outcomes; admission denial only follows an already retained primary failure.
                  lifetime.defer(() => normalize(value.close));
                } else {
                  const run = async (signal: AbortSignal) => {
                    const result = await value.run(signal);
                    if (failed(result)) return result;
                    return;
                  };
                  // eslint-disable-next-line failure/must-use -- close() owns child outcomes; admission denial only follows an already retained primary failure.
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
        return failed(closed) ? closed : UnexpectedDefect({ cause: new Error('Unit construction lost its failure') });
      }
      return { services, quiesce: lifetime.quiesce, close: lifetime.close };
    },
  };
}

/** Rename a unit's published wire keys — the multi-instance primitive. */
export type RenamedProvides<TP, M> = {
  [K in keyof TP as K extends keyof M ? (M[K] extends string ? M[K] : K) : K]: TP[K];
};

/**
 * Mount-time rename. `rename(dbUnit, { db: 'reportsDb' }, 'reports-db')`
 * publishes the same service under a different wire key, retyped
 * accordingly — the way to mount a second instance of an adapter without
 * a key collision. Renames compose: renaming an already-renamed key
 * rewrites the earlier entry.
 *
 * The returned unit's `provides` handles are rebuilt on the new keys and
 * name, so `rename(...).provides.reportsDb` is the handle to reference. A
 * handle taken from the object before the rename keeps the old key — the
 * builder guard reports it missing; reference the handle of the object you
 * mount. Without `newName` the handles keep the original provider.
 */
export function rename<
  P extends AnyUnit,
  TOwnership extends UnitOwnership,
  const M extends { readonly [K in keyof UnitProvides<P>]?: string },
  const TNewName extends string = UnitOwner<P>,
>(
  p: P & {
    readonly runtime: UnitRuntime<TOwnership['open'], TOwnership['close']>;
    readonly [OwnershipSym]?: TOwnership;
  },
  map: M,
  newName?: TNewName,
): Omit<
  Unit<
    UnitNeeds<P>,
    RenamedProvides<UnitProvides<P>, M>,
    UnitProviderIdentities<P>,
    TNewName,
    TOwnership,
    UnitPhaseFailures<P>
  >,
  'hooks' | 'logging' | 'factories'
> &
  Pick<P, 'hooks' | 'logging' | 'factories'> &
  FactoryContractOf<P> {
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
    AnyUnit,
    typeof NeedsSym | typeof ProvidesSym | typeof ProviderIdentitySym | typeof OwnershipSym
  > = p;
  return {
    ...metadata,
    name,
    renames,
    provides: handles as Handles<RenamedProvides<UnitProvides<P>, M>, TNewName>,
    runtime: p.runtime,
  };
}

/**
 * Stable error thrown by DOT unit adapters.
 *
 * Adapters MUST throw `DotUnitError` (not raw `Error`) when surfacing a
 * misconfiguration, missing-input, or other fail-fast condition. Consumers
 * and coding agents can then match on a stable `code`, follow `docsUrl`,
 * and apply `remediation` without parsing the message.
 *
 * Codes are per-adapter. Recommended prefix is `ARKI_<PKG>_UNIT_E<NNN>` (e.g.
 * `ARKI_KV_UNIT_E001`, `ARKI_DB_UNIT_E001`). The kernel does not own the code
 * namespace — each adapter defines its own constants and links them in
 * its README.
 *
 * @see packages/dot/docs/principles.md — principle 1.3 ("errors are part
 * of the API") and principle 4 ("agent-discoverable everywhere").
 */
export class DotUnitError extends Error {
  /** Stable error code, e.g. `ARKI_KV_UNIT_E001`. */
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
    this.name = 'DotUnitError';
    this.code = args.code;
    this.remediation = args.remediation;
    this.docsUrl = args.docsUrl;
  }
}

/** Re-exported for downstream typing. */

export { type ActionManifest, type DotAppManifest, type UnitManifest, type ProjectionManifest } from './manifest.js';
