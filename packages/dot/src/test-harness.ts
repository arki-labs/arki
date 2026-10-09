/**
 * Test harness for unit-testing DOT plugins.
 *
 * Provides `testApp` — a convenience wrapper that lets plugin authors verify
 * lifecycle behaviour, registration, and service publishing without dragging
 * in concrete framework dependencies.
 *
 * NOTE: `testApp` takes an erased plugin array, so the compile-time wiring
 * guard does not apply here — the kernel's runtime validation (unsatisfied
 * needs, collisions) still does. Use `defineApp(...).use(...)` chains in
 * tests that should exercise the type-level guard.
 *
 * @example
 *   import { testApp, plugin } from '@arki/dot';
 *
 *   const myPlugin = plugin({
 *     name: 'counter',
 *     boot: () => ({ counter: { value: 0 } }),
 *   });
 *
 *   it('publishes a counter service', async () => {
 *     const app = await bootTestApp<{ counter: { value: number } }>([myPlugin]);
 *     expect(app.services.counter.value).toBe(0);
 *     await app.dispose();
 *   });
 */

import type { DotApp, DotAppBuilder } from './define-app.js';
import type { AnyPlugin, EmptyShape, Plugin, ServiceRecord, Token } from './plugin-contract.js';
import { defineApp } from './define-app.js';

export type TestAppOptions = {
  /** App name used in the manifest. Defaults to `'test-app'`. */
  name?: string;
  /** Runtime config bag exposed to hooks as `$config`. */
  config?: Readonly<Record<string, unknown>>;
};

/**
 * Guard-free view of the builder for erased plugin arrays. The runtime `use`
 * implementation accepts the missing guard argument (it is type-level
 * only), so this seam is safe — the kernel still validates wiring at boot.
 */
type LooseBuilder = {
  use(plugin: AnyPlugin): LooseBuilder;
};

/**
 * Build a DOT app builder pre-populated with the given plugins, ready to
 * `.configure()`, `.boot()` or `.start()` from a test.
 */
export function testApp<TServices extends ServiceRecord = EmptyShape>(
  plugins: readonly AnyPlugin[] = [],
  options: TestAppOptions = {},
): DotAppBuilder<TServices> {
  let builder: unknown = defineApp(options.name ?? 'test-app', { config: options.config });
  for (const p of plugins) {
    builder = (builder as LooseBuilder).use(p);
  }
  return builder as DotAppBuilder<TServices>;
}

/**
 * Convenience: build, boot, return the running app. Caller is responsible for
 * calling `app.dispose()` when finished.
 */
export async function bootTestApp<TServices extends ServiceRecord = EmptyShape>(
  plugins: readonly AnyPlugin[] = [],
  options: TestAppOptions = {},
): Promise<DotApp<TServices>> {
  return testApp<TServices>(plugins, options).boot();
}

/**
 * Rest-tuple guard for {@link TestPluginBuilder.boot} — the same trick the app
 * builder's `UseGuard` uses. While any need is still unprovided, `boot()`
 * demands an impossible second argument, so the call site fails with
 * "Expected 2 arguments, but got 1" and the error payload names the
 * missing wire keys and their types.
 */
type TestPluginBootGuard<TRemaining extends ServiceRecord> = keyof TRemaining extends never
  ? readonly []
  : readonly [
      needs: {
        readonly 'DOT-TEST: plugin needs still unprovided — call .provide() for each': {
          readonly [K in keyof TRemaining]: TRemaining[K];
        };
      },
    ];

/**
 * Typed unit-test builder for a single plugin — see {@link testPlugin}.
 *
 * `TRemaining` tracks the wire keys not yet covered by `.provide()`;
 * `TServices` accumulates what the booted app will expose (the fakes plus
 * the plugin's own provides).
 */
export type TestPluginBuilder<TRemaining extends ServiceRecord, TServices extends ServiceRecord> = {
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
  ): TestPluginBuilder<Omit<TRemaining, K>, TServices & Readonly<Record<K, T>>>;
  /**
   * Satisfy one need directly with a fake. Key form — for anonymous
   * `service<T>()` needs, where the wire key is the property name:
   *
   * ```ts
   * testPlugin(billing).provide('db', fakeDb)
   * ```
   */
  provide<K extends keyof TRemaining & string>(
    key: K,
    value: TRemaining[K],
  ): TestPluginBuilder<Omit<TRemaining, K>, TServices & Readonly<Record<K, TRemaining[K]>>>;
  /** Boot the plugin against the provided fakes. Compile error until every need is provided. */
  boot(...guard: TestPluginBootGuard<TRemaining>): Promise<DotApp<TServices>>;
  /** Boot + start. Same guard as {@link TestPluginBuilder.boot}. */
  start(...guard: TestPluginBootGuard<TRemaining>): Promise<DotApp<TServices>>;
};

/** Internal accumulating state for {@link testPlugin}. */
type TestPluginState = {
  readonly plugin: AnyPlugin;
  readonly fakes: Readonly<Record<string, unknown>>;
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
 *
 * const app = await testPlugin(catalog)
 *   .provide(Db, fakeDb)          // token need
 *   .provide('cache', fakeKv)     // anonymous need — wire key is the alias
 *   .boot();
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
export function testPlugin<TNeeds extends ServiceRecord, TProvides extends ServiceRecord>(
  plugin: Plugin<TNeeds, TProvides>,
  options: TestAppOptions = {},
): TestPluginBuilder<TNeeds, TProvides> {
  // Erasure seam — same boundary as `makeBuilder` in define-app.ts: the
  // runtime impl is untyped, the type parameters do all the guarding.
  return makeTestPluginBuilder({ plugin: plugin as AnyPlugin, fakes: {}, options }) as TestPluginBuilder<TNeeds, TProvides>;
}

/**
 * Erased implementation behind {@link testPlugin}. Mirrors `makeBuilder` in
 * `define-app.ts`: the runtime is untyped, the single cast at the return
 * is the seam, and the type parameters do all the guarding.
 */
function makeTestPluginBuilder(state: TestPluginState): TestPluginBuilder<ServiceRecord, ServiceRecord> {
  const bootApp = async (): Promise<DotApp<ServiceRecord>> => {
    const plugins: AnyPlugin[] = [];
    if (Object.keys(state.fakes).length > 0) {
      const fakes = { ...state.fakes };
      plugins.push({
        name: `test:fakes(${state.plugin.name})`,
        needs: {},
        actions: [],
        renames: {},
        hooks: { boot: () => fakes },
      });
    }
    plugins.push(state.plugin);
    return testApp<ServiceRecord>(plugins, {
      name: state.options.name ?? `test:${state.plugin.name}`,
      ...(state.options.config === undefined ? {} : { config: state.options.config }),
    }).boot();
  };

  const impl = {
    provide(tokenOrKey: Token<unknown, string> | string, value: unknown) {
      const key = typeof tokenOrKey === 'string' ? tokenOrKey : tokenOrKey.key;
      return makeTestPluginBuilder({ ...state, fakes: { ...state.fakes, [key]: value } });
    },
    async boot(..._guard: readonly unknown[]) {
      return bootApp();
    },
    async start(..._guard: readonly unknown[]) {
      const app = await bootApp();
      await app.start();
      return app;
    },
  };
  return impl as TestPluginBuilder<ServiceRecord, ServiceRecord>;
}
