/**
 * Context management utilities for two-tier architecture
 * Provides singleton service management, lifecycle coordination, and performance tracking
 *
 * @module @arki/dot/context
 */

// Core types
export { ExecutionContext } from './execution-types';
export type { ExecutionContextType } from './execution-types';

// Singleton management
export { SingletonServicesRegistry } from './singleton-registry';

// Lifecycle management
export { globalLifecycle, LifecycleManager } from './lifecycle';

// Lazy initialization
export { lazy, LazyInitializer } from './lazy-initializer';

// Metrics tracking
export { globalMetrics, ServiceMetricsCollector } from './metrics';
export type { MetricsReport, ServiceMetric } from './metrics';

// Base context builder
export { BaseContextBuilder, createBaseContextBuilder } from './base-context';

// Testing utilities
export {
  assertHasServices,
  createDisposableMock,
  createLifecycleSpy,
  createMockContextBuilder,
  createMockMetrics,
  createMockRegistry,
  waitForInitialization
} from './testing';
