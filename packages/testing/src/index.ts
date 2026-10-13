/**
 * @arki/testing - Comprehensive Testing Utilities
 *
 * Provides a complete testing solution for tRPC + Drizzle + PostgreSQL + Redis applications
 * including container management, test data factories, enhanced assertions, debugging tools,
 * and performance measurement utilities.
 *
 * @packageDocumentation
 */

// Core exports
export * from './containers';
export * from './integration-tester';
export * from './types';

// Tester builder (tRPC-style initialization)
export { initTester } from './tester-builder';
export type { TesterConfig } from './tester-builder';

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

// Note: vitest-setup is available as a separate entry point
// Import it directly via '@arki/testing/vitest-setup' in your setup files
