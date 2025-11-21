/**
 * Vitest setup utilities for common mocking patterns
 *
 * Import and call the setup functions in your vitest.setup-files.ts to apply
 * standard mocks across all tests in your project.
 *
 * @example
 * ```ts
 * // vitest.setup-files.ts
 * import { setupCommonMocks } from '@arki/testing/vitest-setup';
 *
 * // Apply all common mocks
 * setupCommonMocks();
 * ```
 */

import { vi } from 'vitest';

/**
 * Mock the 'server-only' package to prevent "Client Component" errors in tests.
 *
 * The server-only package throws a runtime error when imported in client/browser
 * contexts. In Node.js test environments, this mock intercepts the import and
 * provides an empty implementation.
 *
 * Call this function in your vitest.setup-files.ts at the top level.
 */
export function setupServerOnlyMock() {
  vi.mock('server-only', () => ({}));
}

/**
 * Set up all common mocks used across projects.
 *
 * This is a convenience function that calls all individual setup functions.
 * Call this in your vitest.setup-files.ts to apply all standard mocks.
 */
export function setupCommonMocks() {
  setupServerOnlyMock();
  // Add more common mocks here as needed
}

// Re-export vitest utilities for convenience
export { vi, expect, describe, it, test, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
