/**
 * Vitest setup utilities for common mocking patterns
 *
 * Import this file directly in your vitest.setup-files.ts to apply
 * standard mocks across all tests in your project.
 *
 * @example
 * ```ts
 * // vitest.setup-files.ts
 * import '@arki/testing/vitest-setup';
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
 * This mock is automatically applied when you import this module.
 */
vi.mock('server-only', () => ({}));
