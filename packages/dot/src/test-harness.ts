/**
 * Test harness for unit-testing DOT pips.
 *
 * Provides `testApp` — a convenience wrapper that lets pip authors verify
 * lifecycle behaviour, registration, and service publishing without dragging
 * in concrete framework dependencies.
 *
 * NOTE: `testApp` takes an erased pip array, so the compile-time wiring
 * guard does not apply here — the kernel's runtime validation (unsatisfied
 * needs, collisions) still does. Use `defineApp(...).use(...)` chains in
 * tests that should exercise the type-level guard.
 *
 * @example
 *   import { testApp, pip } from '@arki/dot';
 *
 *   const myPip = pip({
 *     name: 'counter',
 *     boot: () => ({ counter: { value: 0 } }),
 *   });
 *
 *   it('publishes a counter service', async () => {
 *     const app = await bootTestApp<{ counter: { value: number } }>([myPip]);
 *     expect(app.services.counter.value).toBe(0);
 *     await app.dispose();
 *   });
 */

import type { DotApp, DotAppBuilder } from './define-app.js';
import type { AnyPip, EmptyShape, ServiceRecord } from './pip-contract.js';
import { defineApp } from './define-app.js';

export type TestAppOptions = {
  /** App name used in the manifest. Defaults to `'test-app'`. */
  name?: string;
  /** Runtime config bag exposed to hooks as `$config`. */
  config?: Readonly<Record<string, unknown>>;
};

/**
 * Guard-free view of the builder for erased pip arrays. The runtime `use`
 * implementation accepts the missing guard argument (it is type-level
 * only), so this seam is safe — the kernel still validates wiring at boot.
 */
type LooseBuilder = {
  use(pip: AnyPip): LooseBuilder;
};

/**
 * Build a DOT app builder pre-populated with the given pips, ready to
 * `.configure()`, `.boot()` or `.start()` from a test.
 */
export function testApp<TServices extends ServiceRecord = EmptyShape>(
  pips: readonly AnyPip[] = [],
  options: TestAppOptions = {},
): DotAppBuilder<TServices> {
  let builder: unknown = defineApp(options.name ?? 'test-app', { config: options.config });
  for (const p of pips) {
    builder = (builder as LooseBuilder).use(p);
  }
  return builder as DotAppBuilder<TServices>;
}

/**
 * Convenience: build, boot, return the running app. Caller is responsible for
 * calling `app.dispose()` when finished.
 */
export async function bootTestApp<TServices extends ServiceRecord = EmptyShape>(
  pips: readonly AnyPip[] = [],
  options: TestAppOptions = {},
): Promise<DotApp<TServices>> {
  return testApp<TServices>(pips, options).boot();
}
