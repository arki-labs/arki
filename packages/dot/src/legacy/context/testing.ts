/**
 * Testing utilities for context management
 * Provides helpers for creating mock contexts and testing lifecycle
 */

import type { ServiceMetric } from './metrics.js';
import { BaseContextBuilder } from './base-context.js';
import { LifecycleManager } from './lifecycle.js';
import { ServiceMetricsCollector } from './metrics.js';
import { SingletonServicesRegistry } from './singleton-registry.js';

/**
 * Create a mock singleton registry for testing
 * Pre-populated with test services
 *
 * @example
 * ```typescript
 * const registry = createMockRegistry({
 *   db: mockDb,
 *   kv: mockKv,
 * });
 * ```
 */
export function createMockRegistry<TServices extends Record<string, unknown>>(
  services: Partial<TServices>,
): SingletonServicesRegistry<TServices> {
  const registry = new SingletonServicesRegistry<TServices>();

  for (const [key, service] of Object.entries(services)) {
    if (service !== undefined) {
      registry.register(key as keyof TServices, service as TServices[keyof TServices]);
    }
  }

  return registry;
}

/**
 * Create a metrics collector with preset data for testing
 *
 * @example
 * ```typescript
 * const metrics = createMockMetrics([
 *   { name: 'db', initTimeMs: 50, accessCount: 100, ageMs: 5000, initialized: true }
 * ]);
 * ```
 */
export function createMockMetrics(initialData?: ServiceMetric[]): ServiceMetricsCollector {
  const collector = new ServiceMetricsCollector();

  if (initialData) {
    for (const metric of initialData) {
      collector.record(metric);
    }
  }

  return collector;
}

/**
 * Wait for a lazy initializer to complete initialization
 * Useful for testing race conditions
 *
 * @example
 * ```typescript
 * const lazy = new LazyInitializer(() => createService());
 * const promise = lazy.get();
 * await waitForInitialization(lazy);
 * expect(lazy.isInitialized()).toBe(true);
 * ```
 */
export async function waitForInitialization<T>(
  lazy: { isInitialized: () => boolean; get: () => Promise<T> },
  timeoutMs = 5000,
): Promise<void> {
  const startTime = Date.now();

  while (!lazy.isInitialized()) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Initialization timeout after ${timeoutMs}ms`);
    }
    await new Promise(resolve => {
      setTimeout(resolve, 10);
    });
  }
}

/**
 * Create a disposable mock service for testing cleanup
 *
 * @example
 * ```typescript
 * const service = createDisposableMock();
 * await registry.dispose();
 * expect(service.disposed).toBe(true);
 * ```
 */
export function createDisposableMock(method: 'dispose' | 'close' | 'destroy' = 'dispose'): {
  disposed: boolean;
  dispose?: () => Promise<void>;
  close?: () => Promise<void>;
  destroy?: () => Promise<void>;
} {
  const mock = { disposed: false };

  const handler = () => {
    mock.disposed = true;
    return Promise.resolve();
  };

  if (method === 'dispose') {
    return { ...mock, dispose: handler };
  }
  if (method === 'close') {
    return { ...mock, close: handler };
  }
  return { ...mock, destroy: handler };
}

/**
 * Create a mock context builder with minimal setup
 * Useful for testing context creation without full initialization
 *
 * @example
 * ```typescript
 * const builder = createMockContextBuilder<AppServices, RequestContext>();
 * await builder.initializeSingletons(registry => {
 *   registry.register('db', mockDb);
 * });
 * ```
 */
export function createMockContextBuilder<
  TSingletons extends Record<string, unknown>,
  TContext extends Record<string, unknown>,
>() {
  return new BaseContextBuilder<TSingletons, TContext>(
    new SingletonServicesRegistry<TSingletons>(),
    new LifecycleManager(),
    new ServiceMetricsCollector(),
  );
}

/**
 * Assert that a service registry has expected services
 *
 * @example
 * ```typescript
 * assertHasServices(registry, ['db', 'kv', 'messageBus']);
 * ```
 */
export function assertHasServices<TServices extends Record<string, unknown>>(
  registry: SingletonServicesRegistry<TServices>,
  expectedKeys: (keyof TServices)[],
): void {
  for (const key of expectedKeys) {
    if (!registry.has(key)) {
      throw new Error(`Expected service '${String(key)}' to be registered`);
    }
  }
}

/**
 * Create a spy for tracking lifecycle handler calls
 *
 * @example
 * ```typescript
 * const spy = createLifecycleSpy();
 * lifecycle.onShutdown(spy.handler);
 * await lifecycle.shutdown();
 * expect(spy.called).toBe(true);
 * ```
 */
export function createLifecycleSpy(): {
  handler: () => Promise<void>;
  called: boolean;
  callCount: number;
  errors: Error[];
} {
  const spy = {
    called: false,
    callCount: 0,
    errors: [] as Error[],
  };

  const handler = () => {
    spy.called = true;
    spy.callCount++;
    return Promise.resolve();
  };

  return { ...spy, handler };
}
