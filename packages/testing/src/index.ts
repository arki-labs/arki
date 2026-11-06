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

// The root loads no Docker client and no msw. These are explicit entries:
//   '@arki/testing/containers'         testcontainers (setupGlobalTestContainers, startPostgresContainer, ...)
//   (IntegrationTester and initTester moved to '@arki/auth/testing/integration-tester'.)
//   '@arki/testing/msw'                msw helpers
//   '@arki/testing/vitest-setup'       vitest setup file
