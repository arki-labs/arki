import { chromium, test as base, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Default test session endpoint mounted by `@arki/auth/tanstack-start`'s
 * `createE2EHandler`. Override via `createAuthGlobalSetup({ createSessionPath })`.
 */
const DEFAULT_CREATE_SESSION_PATH = '/api/e2e/create-session';

/**
 * Resolves to `<dir>/.auth/user.json` relative to the importing module file.
 * Used both by the globalSetup (write side) and the authenticated fixture
 * (read side). Pass the importing module's `import.meta.url` so the path
 * stays anchored to the caller's e2e folder, not the @arki package itself.
 */
export function resolveAuthStatePath(importMetaUrl: string, subdir = '.auth', filename = 'user.json'): string {
  const dir = path.dirname(fileURLToPath(importMetaUrl));
  return path.join(dir, subdir, filename);
}

export type CreateAuthGlobalSetupOptions = {
  /** Origin of the app under test, e.g. `http://localhost:5180`. */
  baseUrl: string;
  /** Absolute path where storageState will be written. */
  authStatePath: string;
  /** POST endpoint that mints a session cookie. Default: `/api/e2e/create-session`. */
  createSessionPath?: string;
  /** Test user email. Forwarded to the endpoint as `{ email }`. */
  email: string;
};

/**
 * Builds a Playwright `globalSetup` default export.
 *
 * Boots a Chromium context, hits the app's test-only `/api/e2e/create-session`
 * endpoint to mint a session cookie, then persists the resulting storageState
 * to disk. The `authenticated` Playwright project (or the fixture below) loads
 * that file so individual tests skip the magic-link / sign-in flow.
 *
 * The endpoint is wired by `@arki/auth/tanstack-start`'s `createE2EHandler`
 * and is 404 in production. ESM `__dirname` plumbing is handled here, not in
 * the caller — pass an absolute `authStatePath` via `resolveAuthStatePath`.
 */
export function createAuthGlobalSetup({
  baseUrl,
  authStatePath,
  createSessionPath = DEFAULT_CREATE_SESSION_PATH,
  email,
}: CreateAuthGlobalSetupOptions) {
  return async function globalSetup(): Promise<void> {
    const browser = await chromium.launch();
    const context = await browser.newContext();

    const response = await context.request.post(`${baseUrl}${createSessionPath}`, {
      data: { email },
    });

    if (!response.ok()) {
      const body = await response.text();
      throw new Error(
        `[@arki/playwright-config] Failed to mint e2e session (${response.status()} ${response.statusText()}): ${body}\n` +
          `Endpoint: ${baseUrl}${createSessionPath}\n` +
          `Confirm the dev server is up, NODE_ENV !== 'production', and createE2EHandler is mounted.`,
      );
    }

    await fs.mkdir(path.dirname(authStatePath), { recursive: true });
    await context.storageState({ path: authStatePath });
    await browser.close();
  };
}

export type AuthenticatedFixtures = {
  authenticatedPage: Page;
};

export type CreateAuthenticatedTestOptions = {
  /** Absolute path to the storageState JSON written by globalSetup. */
  authStatePath: string;
};

/**
 * Returns a Playwright `test` / `expect` pair with an `authenticatedPage`
 * fixture pre-loaded from the storageState file written by globalSetup.
 *
 * @example
 * import { createAuthenticatedTest, resolveAuthStatePath } from '@arki/playwright-config/auth';
 * const { test, expect } = createAuthenticatedTest({
 *   authStatePath: resolveAuthStatePath(import.meta.url),
 * });
 * test('dashboard loads', async ({ authenticatedPage }) => { ... });
 */
export function createAuthenticatedTest({ authStatePath }: CreateAuthenticatedTestOptions) {
  const test = base.extend<AuthenticatedFixtures>({
    authenticatedPage: async ({ browser }, use) => {
      const context = await browser.newContext({ storageState: authStatePath });
      const page = await context.newPage();
      await use(page);
      await context.close();
    },
  });

  return { test, expect: base.expect };
}
