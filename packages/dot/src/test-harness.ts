/**
 * Test harness for unit-testing DOT plugins.
 *
 * Provides `testApp` — a convenience wrapper that lets plugin authors verify
 * lifecycle behaviour, registration, and service publishing without dragging
 * in concrete framework dependencies.
 *
 * @example
 *   import { testApp, defineDotPlugin } from '@arki/dot';
 *
 *   const myPlugin = defineDotPlugin<{ counter: { value: number } }>({
 *     name: 'counter',
 *     async boot() {
 *       return { services: { counter: { value: 0 } } };
 *     },
 *   });
 *
 *   it('publishes a counter service', async () => {
 *     const app = await testApp([myPlugin]).boot();
 *     expect(app.services.counter.value).toBe(0);
 *     await app.dispose();
 *   });
 */

import type { DotApp, DotAppBuilder } from './define-app.js';
import type { AnyDotPlugin, DotPlugin } from './plugin-contract.js';
import { defineApp } from './define-app.js';

export type TestAppOptions = {
  /** App name used in the manifest. Defaults to `'test-app'`. */
  name?: string;
  /** Runtime config bag passed to every boot hook. */
  config?: Readonly<Record<string, unknown>>;
};

/**
 * Build a DOT app builder pre-populated with the given plugins, ready to
 * `.configure()`, `.boot()` or `.start()` from a test.
 */
export function testApp<TServices extends Record<string, unknown> = Record<string, never>>(
  // Accept any plugin shape — tests routinely mix services types. Internally
  // we erase to `AnyDotPlugin` for the kernel.
  plugins: readonly DotPlugin<never>[] | readonly DotPlugin<Record<string, never>>[] | readonly AnyDotPlugin[] = [],
  options: TestAppOptions = {},
): DotAppBuilder<TServices> {
  let builder = defineApp(options.name ?? 'test-app', { config: options.config });
  for (const plugin of plugins) {
    builder = builder.use(plugin as DotPlugin<Record<string, unknown>>);
  }
  return builder as DotAppBuilder<TServices>;
}

/**
 * Convenience: build, boot, return the running app. Caller is responsible for
 * calling `app.dispose()` when finished.
 */
export async function bootTestApp<TServices extends Record<string, unknown> = Record<string, never>>(
  plugins: readonly DotPlugin<never>[] | readonly DotPlugin<Record<string, never>>[] | readonly AnyDotPlugin[] = [],
  options: TestAppOptions = {},
): Promise<DotApp<TServices>> {
  return testApp<TServices>(plugins, options).boot();
}
