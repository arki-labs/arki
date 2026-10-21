/**
 * Test builders that boot units against fakes: `testUnit`, `testApp` and `bootTestApp`.
 *
 * Provides `testApp` — a convenience wrapper that lets unit authors verify
 * lifecycle behaviour, registration, and service publishing without dragging
 * in concrete framework dependencies.
 *
 * Tuples use the compile-time wiring guard. Runtime-built arrays use the
 * kernel's validation of missing needs and collisions at boot.
 *
 * @example
 *   import { bootTestApp, infra } from '@arki/dot';
 *   import { orThrow } from '@arki/failure';
 *
 *   const myUnit = infra({
 *     name: 'counter',
 *     provides: { counter: () => ({ value: 0 }) },
 *   });
 *
 *   it('publishes a counter service', async () => {
 *     const app = orThrow(await bootTestApp([myUnit])); // app.services typed from the units
 *     expect(app.services.counter.value).toBe(0);
 *     await app.dispose();
 *   });
 */

import type { Failure } from '@arki/failure';

import type { DotAppLifecycle, ListGuard, UseAllAvail, UseAllGuard } from './define-app.js';
import type {
  AnyUnit,
  EmptyPhases,
  EmptyShape,
  Handle,
  Handles,
  InferredOwnership,
  Unit,
  UnitCloseFailure,
  UnitNeeds,
  UnitOpenFailure,
  UnitPhaseFailures,
  UnitPhases,
  UnitProvides,
  UnitSourceGuard,
  ProvidedValues,
  RuntimeUnit,
  ServiceRecord,
  Token,
} from './unit-contract.js';
import { mountUnits } from './define-app.js';
import { createUnitRuntime, handleOf } from './unit-contract.js';

export type TestAppOptions = {
  /** App name used in the manifest. Defaults to `'test-app'`. */
  name?: string;
  /** Runtime config bag exposed to hooks as `$config`. */
  config?: Readonly<Record<string, unknown>>;
};

/** Runtime operation lists retain the ownership inferred at their authoring boundaries. */
function runtimeUnits<const Units extends readonly AnyUnit[]>(
  plugins: Units,
): readonly RuntimeUnit<
  UnitOpenFailure<Units[number]>,
  UnitCloseFailure<Units[number]>,
  UnitPhaseFailures<Units[number]>
>[];
function runtimeUnits(units: readonly AnyUnit[]): readonly AnyUnit[] {
  return units;
}

/** Project one checked unit onto the execution contract its callbacks own. */
function runtimeUnit<P extends AnyUnit>(
  plugin: P,
): RuntimeUnit<UnitOpenFailure<P>, UnitCloseFailure<P>, UnitPhaseFailures<P>>;
function runtimeUnit(unit: AnyUnit): AnyUnit {
  return unit;
}

/**
 * What `testApp(units)` exposes as `app.services`: the services the tuple
 * accumulates, as `.infra(...)` would type them. A runtime-built array
 * (`feature.units()`) has no tuple to read, so it gets the open record.
 */
export type TestAppServices<TUnits extends readonly AnyUnit[]> = number extends TUnits['length']
  ? ServiceRecord
  : UseAllAvail<EmptyShape, TUnits>;

/**
 * The `.infra(...)` wiring check on the argument, minus the tuple requirement:
 * a test may mount a runtime-built array and let the kernel check it at boot.
 */
type TestAppGuard<TUnits extends readonly AnyUnit[]> = number extends TUnits['length']
  ? ListGuard<UnitSourceGuard<TUnits[number]>>
  : ListGuard<UseAllGuard<EmptyShape, TUnits>>;

/**
 * Build a DOT app builder pre-populated with the given units, ready to
 * `.configure()`, `.boot()` or `.start()` from a test. The services are read
 * off the units — `testApp([database]).boot()` gives `app.services.db` —
 * and a tuple that would not mount (a need before its provider, a wire key
 * provided twice) is a compile error on the argument.
 */
export function testApp<const TUnits extends readonly AnyUnit[] = readonly []>(
  units?: TUnits & TestAppGuard<TUnits>,
  options: TestAppOptions = {},
) {
  return mountUnits<
    UnitOpenFailure<TUnits[number]>,
    UnitCloseFailure<TUnits[number]>,
    TestAppServices<TUnits>,
    UnitPhaseFailures<TUnits[number]>
  >(options.name ?? 'test-app', runtimeUnits(units ?? []), { config: options.config });
}

/** Build and boot an app, returning declared ownership failures to its caller. */
export function bootTestApp<const TUnits extends readonly AnyUnit[] = readonly []>(
  units?: TUnits & TestAppGuard<TUnits>,
  options: TestAppOptions = {},
) {
  return testApp<TUnits>(units, options).boot();
}

/**
 * `this` type for {@link TestUnitBuilder.boot}: the builder itself once every
 * need is provided, else a record naming the missing wire keys and their
 * types. A `this` parameter puts that record in the error text ("The 'this'
 * context of type … is not assignable to method's 'this' of type { 'DOT-TEST:
 * …' }"), on the `.boot()` call.
 */
type BootReady<TRemaining extends ServiceRecord, TSelf> = keyof TRemaining extends never
  ? TSelf
  : {
      readonly 'DOT-TEST: unit needs still unprovided — call .provide() for each': {
        readonly [K in keyof TRemaining]: TRemaining[K];
      };
    };

/**
 * Typed unit-test builder for a single unit — see {@link testUnit}.
 *
 * `TRemaining` tracks the wire keys not yet covered by `.provide()`;
 * `TServices` accumulates what the booted app will expose (the fakes plus
 * the unit's own provides).
 */
type TestUnitLifecycle<
  Services extends ServiceRecord,
  Open extends Failure,
  Close extends Failure,
  Fakes extends ServiceRecord,
  Phases extends UnitPhases,
> = DotAppLifecycle<
  Services,
  Open | InferredOwnership<Fakes, void>['open'],
  Close | InferredOwnership<Fakes, void>['close'],
  Phases
>;

export type TestUnitBuilder<
  TRemaining extends ServiceRecord,
  TServices extends ServiceRecord,
  TOpen extends Failure = never,
  TClose extends Failure = never,
  TFakes extends ServiceRecord = EmptyShape,
  TPhases extends UnitPhases = EmptyPhases,
> = {
  /**
   * Satisfy one need directly with a fake. Token form — the token names
   * the wire key and carries the type:
   *
   * ```ts
   * testUnit(reports).provide(Db, fakeDb)
   * ```
   */
  provide<K extends keyof TRemaining & string, T extends TRemaining[K]>(
    token: Token<T, K>,
    value: T,
  ): TestUnitBuilder<
    Omit<TRemaining, K>,
    TServices & Readonly<Record<K, T>>,
    TOpen,
    TClose,
    TFakes & Readonly<Record<K, T>>,
    TPhases
  >;
  /**
   * Satisfy one need directly with a fake. Key form — for anonymous
   * `service<T>()` needs, where the wire key is the property name:
   *
   * ```ts
   * testUnit(billing).provide('db', fakeDb)
   * ```
   */
  provide<K extends keyof TRemaining & string, T extends TRemaining[K]>(
    key: K,
    value: T,
  ): TestUnitBuilder<
    Omit<TRemaining, K>,
    TServices & Readonly<Record<K, T>>,
    TOpen,
    TClose,
    TFakes & Readonly<Record<K, T>>,
    TPhases
  >;
  /** Boot the unit against the provided fakes. Compile error until every need is provided. */
  boot(
    this: BootReady<TRemaining, TestUnitBuilder<TRemaining, TServices, TOpen, TClose, TFakes, TPhases>>,
  ): ReturnType<TestUnitLifecycle<TServices, TOpen, TClose, TFakes, TPhases>['boot']>;
  /** Boot + start. Same guard as {@link TestUnitBuilder.boot}. */
  start(
    this: BootReady<TRemaining, TestUnitBuilder<TRemaining, TServices, TOpen, TClose, TFakes, TPhases>>,
  ): ReturnType<TestUnitLifecycle<TServices, TOpen, TClose, TFakes, TPhases>['start']>;
};

/** Internal accumulating state for {@link testUnit}. */
type TestUnitState<
  Open extends Failure,
  Close extends Failure,
  Fakes extends ServiceRecord,
  Phases extends UnitPhases,
> = {
  readonly plugin: RuntimeUnit<Open, Close, Phases>;
  readonly fakes: Fakes;
  readonly options: TestAppOptions;
};

/**
 * Unit-test a single unit with **typed overrides** — the compile-checked
 * counterpart to {@link testApp}'s erased arrays.
 *
 * Each `.provide()` satisfies one of the unit's needs directly (no real
 * provider unit, no dependency chain) and removes it from the builder's
 * remaining-needs type. `boot()` only compiles once every need is covered,
 * and a fake of the wrong shape fails at the `.provide()` call site:
 *
 * ```ts
 * import { testUnit } from '@arki/dot/test-harness';
 * import { orThrow } from '@arki/failure';
 *
 * const app = orThrow(await testUnit(catalog)
 *   .provide(Db, fakeDb)          // token need
 *   .provide('cache', fakeKv)     // anonymous need — wire key is the alias
 *   .boot());
 *
 * expect(app.services.catalog.list()).toEqual([]);
 * await app.dispose();
 * ```
 *
 * `service.lazy<T>()` needs accept either a plain `T` fake (the kernel
 * lifts it) or a `Lazy<T>` handle (`lazyOf(value)` is handy here).
 * Lifecycle semantics are the real kernel's — the fakes are published by a
 * synthetic first unit, so reverse-order teardown and lazy auto-dispose
 * behave exactly as in production.
 */
export function testUnit<const P extends AnyUnit>(
  unit: P & ListGuard<UnitSourceGuard<P>>,
  options: TestAppOptions = {},
) {
  return makeTestUnitBuilder<
    UnitNeeds<P>,
    UnitProvides<P>,
    UnitOpenFailure<P>,
    UnitCloseFailure<P>,
    EmptyShape,
    UnitPhaseFailures<P>
  >({
    plugin: runtimeUnit<P>(unit),
    fakes: {},
    options,
  });
}

/** The factories return their original fake values; only their computed key record is remapped. */
function fakeUnit<Fakes extends ServiceRecord>(
  name: string,
  fakes: Fakes,
): Omit<Unit<EmptyShape, ProvidedValues<Fakes>, EmptyShape, string, InferredOwnership<Fakes, void>>, 'hooks'> & {
  readonly hooks: EmptyShape;
} {
  const entries = Object.entries(fakes);
  const factories = Object.fromEntries(entries.map(([key, value]) => [key, () => value])) as {
    readonly [K in keyof Fakes]: () => Fakes[K];
  };
  return {
    name,
    needs: {},
    actions: [],
    renames: {},
    provides: Object.fromEntries(entries.map(([key]) => [key, handleOf(key, name)])) as Handles<ProvidedValues<Fakes>>,
    factories,
    runtime: createUnitRuntime(),
    hooks: {},
  };
}

/** Generic state keeps closed operations typed while fakes accumulate by wire key. */
function makeTestUnitBuilder<
  Remaining extends ServiceRecord,
  Services extends ServiceRecord,
  Open extends Failure,
  Close extends Failure,
  Fakes extends ServiceRecord,
  Phases extends UnitPhases,
>(
  state: TestUnitState<Open, Close, Fakes, Phases>,
): TestUnitBuilder<Remaining, Services, Open, Close, Fakes, Phases> {
  const appBuilder = () => {
    const units: RuntimeUnit<
      Open | InferredOwnership<Fakes, void>['open'],
      Close | InferredOwnership<Fakes, void>['close'],
      Phases
    >[] = [];
    if (Object.keys(state.fakes).length > 0) units.push(fakeUnit(`test:fakes(${state.plugin.name})`, state.fakes));
    units.push(state.plugin);
    return mountUnits<
      Open | InferredOwnership<Fakes, void>['open'],
      Close | InferredOwnership<Fakes, void>['close'],
      Services,
      Phases
    >(state.options.name ?? `test:${state.plugin.name}`, units, { config: state.options.config });
  };

  function provide<K extends keyof Remaining & string, Value extends Remaining[K]>(
    tokenOrKey: Token<Value, K> | K,
    value: Value,
  ) {
    const key = typeof tokenOrKey === 'string' ? tokenOrKey : tokenOrKey.key;
    // Computed-key construction preserves the same key and value supplied by provide().
    const fakes = { ...state.fakes, [key]: value } as Fakes & Readonly<Record<K, Value>>;
    return makeTestUnitBuilder<
      Omit<Remaining, K>,
      Services & Readonly<Record<K, Value>>,
      Open,
      Close,
      typeof fakes,
      Phases
    >({
      ...state,
      fakes,
    });
  }

  return {
    provide,
    boot: () => appBuilder().boot(),
    start: () => appBuilder().start(),
  };
}

/**
 * A unit that provides one fake under a real handle's wire key — for
 * app-level tests that mount the real features against fakes:
 *
 * ```ts
 * defineApp('test').infra(fake(database.provides.db, db)).features([...features])
 * ```
 *
 * The fake is type-checked against the handle: a wrong-shaped value fails
 * at the call site. The unit is named `fake:<key>`.
 */
export function fake<T, K extends string, Value extends NoInfer<T>>(handle: Handle<T, K>, value: Value) {
  // Erasure seam: the factory record is built under `handle.key` at
  // runtime; its type is exactly `{ [handle.key]: Value }`.
  const fakes = { [handle.key]: value } as Readonly<Record<K, Value>>;
  return fakeUnit(`fake:${handle.key}`, fakes);
}
