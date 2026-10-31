/**
 * @arki/testing - Comprehensive Testing Utilities
 *
 * Provides a complete testing solution for tRPC + Drizzle + PostgreSQL + Redis applications
 * including container management, test data factories, enhanced assertions, debugging tools,
 * and performance measurement utilities.
 *
 * @packageDocumentation
 */

// Factory system
export * from './factories.js';
export { createFactories } from './factories.js';

// Enhanced assertions
export * from './assertions.js';
export * from './timestamps.js';

// Debug utilities
export * from './debug.js';

// Performance utilities
export * from './performance.js';

// The root loads no Docker client, no msw and no `@arki/auth`. These are explicit entries:
//   '@arki/testing/containers'         testcontainers (setupGlobalTestContainers, startPostgresContainer, ...)
//   '@arki/testing/server/integration-tester' IntegrationTester and its types, TestUser etc. (needs `@arki/auth`)
//   '@arki/testing/server/tester-builder'     initTester (needs `@arki/auth`)
//   '@arki/testing/msw'                msw helpers
//   '@arki/testing/vitest-setup'       vitest setup file
