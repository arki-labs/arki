/**
 * Context management utilities for two-tier architecture
 * Provides singleton service management, lifecycle coordination, and performance tracking
 *
 * @module @arki/dot/context
 */

// Core types
export { ExecutionContext } from './execution-types.js';
export type { ExecutionContextType } from './execution-types.js';

// Singleton management
export { SingletonServicesRegistry } from './singleton-registry.js';

// Lifecycle management
export { globalLifecycle, LifecycleManager } from './lifecycle.js';

// Lazy initialization
export { lazy, LazyInitializer } from './lazy-initializer.js';

// Metrics tracking
export { globalMetrics, ServiceMetricsCollector } from './metrics.js';
export type { MetricsReport, ServiceMetric } from './metrics.js';

// Base context builder
export { BaseContextBuilder, createBaseContextBuilder } from './base-context.js';

// Testing utilities
export {
  assertHasServices,
  createDisposableMock,
  createLifecycleSpy,
  createMockContextBuilder,
  createMockMetrics,
  createMockRegistry,
  waitForInitialization,
} from './testing.js';
