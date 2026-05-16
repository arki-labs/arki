/**
 * MSW (Mock Service Worker) primitives for Vitest-based HTTP testing.
 *
 * Use this when your production code calls external HTTP services (REST APIs,
 * webhooks, third-party SaaS) and you want network-layer intercepts rather
 * than `vi.fn`-style fetch stubs. MSW preserves the real Request/Response/URL
 * machinery, so the impl's `encodeURIComponent`, headers, and URL parsing
 * actually execute — the test only swaps the network response.
 *
 * ## Quick start
 *
 * 1. Setup file (`__tests__/setup/msw.ts`):
 *    ```ts
 *    import { setupMswServer } from '@arki/testing/msw';
 *    export const server = setupMswServer();
 *    ```
 *
 * 2. Register it in `vitest.config.ts`:
 *    ```ts
 *    test: { setupFiles: ['./__tests__/setup/msw.ts'] }
 *    ```
 *
 * 3. Use in tests:
 *    ```ts
 *    import { http, HttpResponse } from '@arki/testing/msw';
 *    import { server } from './setup/msw';
 *
 *    it('handles 503', async () => {
 *      server.use(http.get('https://api.example.com/x', () =>
 *        new HttpResponse(null, { status: 503 })));
 *      await expect(callApi()).rejects.toThrow(/503/);
 *    });
 *    ```
 *
 * The default policy is `onUnhandledRequest: 'error'` — any request that no
 * handler matches will fail the test. This catches accidental real-network
 * calls and URL-construction bugs (e.g. an un-encoded slug breaking the path
 * shape) that fetch-stubbing silently swallows.
 */
import type { RequestHandler } from 'msw';
import type { SetupServer } from 'msw/node';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

/**
 * Policy for handling requests that match no registered handler.
 *
 * - `error` (default) — fail the test. Recommended for unit/integration tests
 *   so you notice when production code calls an unexpected URL.
 * - `warn` — log a warning, then let the request pass through to the real
 *   network. Useful when migrating an existing test suite incrementally.
 * - `bypass` — silent passthrough. Avoid; defeats the point of MSW in tests.
 */
export type UnhandledRequestPolicy = 'error' | 'warn' | 'bypass';

export type SetupMswServerOptions = {
  /** Initial handlers. Rarely needed — prefer per-test `server.use(...)`. */
  handlers?: RequestHandler[];
  /** Policy for unmatched requests. Default: `'error'` (fail-loud). */
  onUnhandledRequest?: UnhandledRequestPolicy;
};

/**
 * Create an MSW server and wire it to Vitest's lifecycle hooks.
 *
 * Registers `beforeAll(listen)`, `afterEach(resetHandlers)`, and `afterAll(close)`
 * by side effect. Returns the `SetupServer` so tests can call `server.use(...)`
 * for per-test handler overrides.
 */
export function setupMswServer(options: SetupMswServerOptions = {}): SetupServer {
  const server = setupServer(...(options.handlers ?? []));

  beforeAll(() => {
    server.listen({ onUnhandledRequest: options.onUnhandledRequest ?? 'error' });
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });

  return server;
}

// Re-export the common MSW authoring surface so consumers don't need a direct
// `msw` dependency. One import line per test file.
export { delay, http, HttpResponse, passthrough } from 'msw';
export type { DefaultBodyType, HttpHandler, RequestHandler, ResponseResolver, StrictRequest } from 'msw';
export type { SetupServer } from 'msw/node';
