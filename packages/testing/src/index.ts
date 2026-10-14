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
export * from './factories';
export { createFactories } from './factories';

// Enhanced assertions
export * from './assertions';
export * from './timestamps';

// Debug utilities
export * from './debug';

// Performance utilities
export * from './performance';

// The root loads no Docker client, no msw and no `@arki/auth`. These are explicit entries:
//   '@arki/testing/containers'         testcontainers (setupGlobalTestContainers, startPostgresContainer, ...)
//   '@arki/testing/server/integration-tester' IntegrationTester and its types, TestUser etc. (needs `@arki/auth`)
//   '@arki/testing/server/tester-builder'     initTester (needs `@arki/auth`)
//   '@arki/testing/msw'                msw helpers
//   '@arki/testing/vitest-setup'       vitest setup file
