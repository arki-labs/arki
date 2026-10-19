/**
 * Test builders that boot plugins against fakes: `testPlugin`, `testApp` and `bootTestApp`.
 *
 * Provides `testApp` — a convenience wrapper that lets plugin authors verify
 * lifecycle behaviour, registration, and service publishing without dragging
 * in concrete framework dependencies.
 *
 * Tuples use the compile-time wiring guard. Runtime-built arrays use the
 * kernel's validation of missing needs and collisions at boot.
 *
 * @example
 *   import { bootTestApp, plugin } from '@arki/dot';
 *   import { orThrow } from '@arki/failure';
 *
 *   const myPlugin = plugin({
 *     name: 'counter',
 *     provides: { counter: () => ({ value: 0 }) },
 *   });
 *
 *   it('publishes a counter service', async () => {
 *     const app = orThrow(await bootTestApp([myPlugin])); // app.services typed from the plugins
 *     expect(app.services.counter.value).toBe(0);
 *     await app.dispose();
 *   });
 */

import type { Failure } from '@arki/failure';

import type { DotAppBuilder, DotAppLifecycle, ListGuard, UseAllAvail, UseAllGuard } from './define-app.js';
import type {
  AnyPlugin,
  EmptyShape,
  Handle,
  Handles,
  InferredOwnership,
  NeedsShape,
  Plugin,
  PluginCloseFailure,
  PluginOpenFailure,
  PluginOwnership,
  ProvidedValues,
  RuntimePlugin,
  ServiceRecord,
  Token,
} from './plugin-contract.js';
import { mountPlugins } from './define-app.js';
import { createPluginRuntime, handleOf } from './plugin-contract.js';

export type TestAppOptions = {
  /** App name used in the manifest. Defaults to `'test-app'`. */
  name?: string;
  /** Runtime config bag exposed to hooks as `$config`. */
  config?: Readonly<Record<string, unknown>>;
};

/** Runtime operation lists retain the ownership inferred at their authoring boundaries. */
function runtimePlugins<const Plugins extends readonly AnyPlugin[]>(
  plugins: Plugins,
): readonly RuntimePlugin<PluginOpenFailure<Plugins[number]>, PluginCloseFailure<Plugins[number]>>[];
function runtimePlugins(plugins: readonly AnyPlugin[]): readonly AnyPlugin[] {
  return plugins;
}

/**
 * What `testApp(plugins)` exposes as `app.services`: the services the tuple
 * accumulates, as `.useAll()` would type them. A runtime-built array
 * (`feature.plugins()`) has no tuple to read, so it gets the open record.
 */
export type TestAppServices<TPlugins extends readonly AnyPlugin[]> = number extends TPlugins['length']
  ? ServiceRecord
  : UseAllAvail<EmptyShape, TPlugins>;

/**
 * The `.useAll()` wiring check on the argument, minus the tuple requirement:
 * a test may mount a runtime-built array and let the kernel check it at boot.
 */
type TestAppGuard<TPlugins extends readonly AnyPlugin[]> = number extends TPlugins['length']
  ? unknown
  : ListGuard<UseAllGuard<EmptyShape, TPlugins>>;

/**
 * Build a DOT app builder pre-populated with the given plugins, ready to
 * `.configure()`, `.boot()` or `.start()` from a test. The services are read
 * off the plugins — `testApp([database]).boot()` gives `app.services.db` —
 * and a tuple that would not mount (a need before its provider, a wire key
 * provided twice) is a compile error on the argument.
 */
export function testApp<const TPlugins extends readonly AnyPlugin[] = readonly []>(
  plugins?: TPlugins & TestAppGuard<TPlugins>,
  options: TestAppOptions = {},
): DotAppBuilder<TestAppServices<TPlugins>, PluginOpenFailure<TPlugins[number]>, PluginCloseFailure<TPlugins[number]>> {
  return mountPlugins<
    PluginOpenFailure<TPlugins[number]>,
    PluginCloseFailure<TPlugins[number]>,
    TestAppServices<TPlugins>
  >(options.name ?? 'test-app', runtimePlugins(plugins ?? []), { config: options.config });
}

/** Build and boot an app, returning declared ownership failures to its caller. */
export function bootTestApp<const TPlugins extends readonly AnyPlugin[] = readonly []>(
  plugins?: TPlugins & TestAppGuard<TPlugins>,
  options: TestAppOptions = {},
) {
  return testApp<TPlugins>(plugins, options).boot();
}

/**
 * `this` type for {@link TestPluginBuilder.boot}: the builder itself once every
 * need is provided, else a record naming the missing wire keys and their
 * types. A `this` parameter puts that record in the error text ("The 'this'
 * context of type … is not assignable to method's 'this' of type { 'DOT-TEST:
 * …' }"), on the `.boot()` call.
 */
type BootReady<TRemaining extends ServiceRecord, TSelf> = keyof TRemaining extends never
  ? TSelf
  : {
      readonly 'DOT-TEST: plugin needs still unprovided — call .provide() for each': {
        readonly [K in keyof TRemaining]: TRemaining[K];
      };
    };

/**
 * Typed unit-test builder for a single plugin — see {@link testPlugin}.
 *
 * `TRemaining` tracks the wire keys not yet covered by `.provide()`;
 * `TServices` accumulates what the booted app will expose (the fakes plus
 * the plugin's own provides).
 */
type TestPluginLifecycle<
  Services extends ServiceRecord,
  Open extends Failure,
  Close extends Failure,
  Fakes extends ServiceRecord,
> = DotAppLifecycle<
  Services,
  Open | InferredOwnership<Fakes, void>['open'],
  Close | InferredOwnership<Fakes, void>['close']
>;

export type TestPluginBuilder<
  TRemaining extends ServiceRecord,
  TServices extends ServiceRecord,
  TOpen extends Failure = never,
  TClose extends Failure = never,
  TFakes extends ServiceRecord = EmptyShape,
> = {
  /**
   * Satisfy one need directly with a fake. Token form — the token names
   * the wire key and carries the type:
   *
   * ```ts
   * testPlugin(reports).provide(Db, fakeDb)
   * ```
   */
  provide<K extends keyof TRemaining & string, T extends TRemaining[K]>(
    token: Token<T, K>,
    value: T,
  ): TestPluginBuilder<
    Omit<TRemaining, K>,
    TServices & Readonly<Record<K, T>>,
    TOpen,
    TClose,
    TFakes & Readonly<Record<K, T>>
  >;
  /**
   * Satisfy one need directly with a fake. Key form — for anonymous
   * `service<T>()` needs, where the wire key is the property name:
   *
   * ```ts
   * testPlugin(billing).provide('db', fakeDb)
   * ```
   */
  provide<K extends keyof TRemaining & string, T extends TRemaining[K]>(
    key: K,
    value: T,
  ): TestPluginBuilder<
    Omit<TRemaining, K>,
    TServices & Readonly<Record<K, T>>,
    TOpen,
    TClose,
    TFakes & Readonly<Record<K, T>>
  >;
  /** Boot the plugin against the provided fakes. Compile error until every need is provided. */
  boot(
    this: BootReady<TRemaining, TestPluginBuilder<TRemaining, TServices, TOpen, TClose, TFakes>>,
  ): ReturnType<TestPluginLifecycle<TServices, TOpen, TClose, TFakes>['boot']>;
  /** Boot + start. Same guard as {@link TestPluginBuilder.boot}. */
  start(
    this: BootReady<TRemaining, TestPluginBuilder<TRemaining, TServices, TOpen, TClose, TFakes>>,
  ): ReturnType<TestPluginLifecycle<TServices, TOpen, TClose, TFakes>['boot']>;
};

/** Internal accumulating state for {@link testPlugin}. */
type TestPluginState<Open extends Failure, Close extends Failure, Fakes extends ServiceRecord> = {
  readonly plugin: RuntimePlugin<Open, Close>;
  readonly fakes: Fakes;
  readonly options: TestAppOptions;
};

/**
 * Unit-test a single plugin with **typed overrides** — the compile-checked
 * counterpart to {@link testApp}'s erased arrays.
 *
 * Each `.provide()` satisfies one of the plugin's needs directly (no real
 * provider plugin, no dependency chain) and removes it from the builder's
 * remaining-needs type. `boot()` only compiles once every need is covered,
 * and a fake of the wrong shape fails at the `.provide()` call site:
 *
 * ```ts
 * import { testPlugin } from '@arki/dot/test-harness';
 * import { orThrow } from '@arki/failure';
 *
 * const app = orThrow(await testPlugin(catalog)
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
 * synthetic first plugin, so reverse-order teardown and lazy auto-dispose
 * behave exactly as in production.
 */
export function testPlugin<
  TNeeds extends ServiceRecord,
  TProvides extends ServiceRecord,
  TShape extends NeedsShape,
  TName extends string,
  TOwnership extends PluginOwnership,
>(
  plugin: Plugin<TNeeds, TProvides, TShape, TName, TOwnership>,
  options: TestAppOptions = {},
): TestPluginBuilder<TNeeds, TProvides, TOwnership['open'], TOwnership['close']> {
  return makeTestPluginBuilder<TNeeds, TProvides, TOwnership['open'], TOwnership['close'], EmptyShape>({
    plugin,
    fakes: {},
    options,
  });
}

/** The factories return their original fake values; only their computed key record is remapped. */
function fakePlugin<Fakes extends ServiceRecord>(
  name: string,
  fakes: Fakes,
): Plugin<EmptyShape, ProvidedValues<Fakes>, EmptyShape, string, InferredOwnership<Fakes, void>> {
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
    runtime: createPluginRuntime<Fakes, void>(factories),
    hooks: {},
  };
}

/** Generic state keeps closed operations typed while fakes accumulate by wire key. */
function makeTestPluginBuilder<
  Remaining extends ServiceRecord,
  Services extends ServiceRecord,
  Open extends Failure,
  Close extends Failure,
  Fakes extends ServiceRecord,
>(state: TestPluginState<Open, Close, Fakes>): TestPluginBuilder<Remaining, Services, Open, Close, Fakes> {
  const appBuilder = () => {
    const plugins: RuntimePlugin<
      Open | InferredOwnership<Fakes, void>['open'],
      Close | InferredOwnership<Fakes, void>['close']
    >[] = [];
    if (Object.keys(state.fakes).length > 0) plugins.push(fakePlugin(`test:fakes(${state.plugin.name})`, state.fakes));
    plugins.push(state.plugin);
    return mountPlugins<
      Open | InferredOwnership<Fakes, void>['open'],
      Close | InferredOwnership<Fakes, void>['close'],
      Services
    >(state.options.name ?? `test:${state.plugin.name}`, plugins, { config: state.options.config });
  };

  function provide<K extends keyof Remaining & string, Value extends Remaining[K]>(
    tokenOrKey: Token<Value, K> | K,
    value: Value,
  ) {
    const key = typeof tokenOrKey === 'string' ? tokenOrKey : tokenOrKey.key;
    // Computed-key construction preserves the same key and value supplied by provide().
    const fakes = { ...state.fakes, [key]: value } as Fakes & Readonly<Record<K, Value>>;
    return makeTestPluginBuilder<Omit<Remaining, K>, Services & Readonly<Record<K, Value>>, Open, Close, typeof fakes>({
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
 * A plugin that provides one fake under a real handle's wire key — for
 * app-level tests that mount the real features against fakes:
 *
 * ```ts
 * defineApp('test').use(fake(database.provides.db, db)).features([...features])
 * ```
 *
 * The fake is type-checked against the handle: a wrong-shaped value fails
 * at the call site. The plugin is named `fake:<key>`.
 */
export function fake<T, K extends string, Value extends NoInfer<T>>(handle: Handle<T, K>, value: Value) {
  // Erasure seam: the factory record is built under `handle.key` at
  // runtime; its type is exactly `{ [handle.key]: Value }`.
  const fakes = { [handle.key]: value } as Readonly<Record<K, Value>>;
  return fakePlugin(`fake:${handle.key}`, fakes);
}
