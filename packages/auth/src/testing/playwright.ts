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
        `[@arki/auth] Failed to mint e2e session (${response.status()} ${response.statusText()}): ${body}\n` +
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
 * import { createAuthenticatedTest, resolveAuthStatePath } from '@arki/auth/testing/playwright';
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

/**
 * Email + storageState path pair for the two accounts the fixture mints.
 * Use stable string keys (`a` / `b`) so spec code reads as a domain
 * statement (`pageA` is "the first authenticated account", not "the one
 * whose email starts with the lowest-alphabetic character").
 */
export type TwoAccountEmails = { a: string; b: string };
export type TwoAccountStatePaths = { a: string; b: string };

export type CreateTwoAccountGlobalSetupOptions = Omit<
  CreateAuthGlobalSetupOptions,
  'email' | 'authStatePath'
> & {
  emails: TwoAccountEmails;
  authStatePaths: TwoAccountStatePaths;
};

/**
 * Builds a Playwright `globalSetup` default export that mints TWO distinct
 * authenticated storageState files — one per account — by calling
 * `createAuthGlobalSetup` twice with the configured email/path pairs.
 *
 * Runs both setups in parallel via `Promise.all` (plan-eng-review perf
 * finding 2026-05-29). Each underlying `createAuthGlobalSetup` launches
 * its own Chromium instance; running both concurrently saves ~2-3s of
 * cold-cache wall-clock per suite invocation at the cost of ~300MB
 * additional peak memory during the brief boot overlap. Modern CI workers
 * (4GB+) and local dev machines handle the overlap without issue; the
 * memory is released as soon as both browsers close at the end of the
 * setup run. For 10+ accounts the trade-off would invert — at 2 accounts
 * parallel is the right call.
 *
 * Use when a spec must drive Account A and Account B in the same run —
 * cross-account ownership (US-15), permission boundaries, multi-tenant
 * isolation. For single-account specs, use `createAuthGlobalSetup` directly.
 *
 * @example
 * import {
 *   createTwoAccountGlobalSetup,
 *   resolveAuthStatePath,
 * } from '@arki/auth/testing/playwright';
 *
 * export default createTwoAccountGlobalSetup({
 *   baseUrl: 'http://localhost:5197',
 *   emails: { a: 'a@novelette.test', b: 'b@novelette.test' },
 *   authStatePaths: {
 *     a: resolveAuthStatePath(import.meta.url, '.auth', 'account-a.json'),
 *     b: resolveAuthStatePath(import.meta.url, '.auth', 'account-b.json'),
 *   },
 * });
 */
export function createTwoAccountGlobalSetup({
  baseUrl,
  createSessionPath,
  emails,
  authStatePaths,
}: CreateTwoAccountGlobalSetupOptions) {
  return async function twoAccountGlobalSetup(): Promise<void> {
    await Promise.all([
      createAuthGlobalSetup({
        baseUrl,
        createSessionPath,
        email: emails.a,
        authStatePath: authStatePaths.a,
      })(),
      createAuthGlobalSetup({
        baseUrl,
        createSessionPath,
        email: emails.b,
        authStatePath: authStatePaths.b,
      })(),
    ]);
  };
}

/**
 * Fixtures contributed by `createTwoAccountTest`.
 *
 * Each `pageA` / `pageB` is a fresh `BrowserContext.newPage()` loaded with
 * the respective account's storageState. Both contexts share the worker's
 * single browser instance — Playwright handles the context isolation.
 */
export type TwoAccountFixtures = {
  pageA: Page;
  pageB: Page;
};

export type CreateTwoAccountTestOptions = {
  authStatePaths: TwoAccountStatePaths;
};

/**
 * Returns a Playwright `test` / `expect` pair with `pageA` + `pageB`
 * fixtures — each pre-loaded from the storageState file for the
 * corresponding account. Both fixtures dispose their browser context on
 * teardown.
 *
 * Spec code reads naturally:
 *
 * ```typescript
 * test('B cannot see A's universe', async ({ pageA, pageB }) => {
 *   const created = await createUniverseAs(pageA, 'A-only');
 *   const list = await listUniversesAs(pageB);
 *   expect(list.items.find((u) => u.id === created.id)).toBeUndefined();
 * });
 * ```
 */
export function createTwoAccountTest({ authStatePaths }: CreateTwoAccountTestOptions) {
  const test = base.extend<TwoAccountFixtures>({
    // baseURL is propagated from `playwright.config.ts` -> `browser.newContext`
    // so that `pageA.request.post('/api/...')` resolves correctly. Without it
    // the request context has no base and any relative URL throws
    // `apiRequestContext.post: Invalid URL`. The browser-level `page.goto`
    // does NOT need this — Playwright's page navigation reads baseURL from
    // testInfo directly — but the API request context inside a manually-
    // created BrowserContext only inherits options passed to newContext.
    pageA: async ({ browser, baseURL }, use) => {
      const context = await browser.newContext({ storageState: authStatePaths.a, baseURL });
      const page = await context.newPage();
      await use(page);
      await context.close();
    },
    pageB: async ({ browser, baseURL }, use) => {
      const context = await browser.newContext({ storageState: authStatePaths.b, baseURL });
      const page = await context.newPage();
      await use(page);
      await context.close();
    },
  });

  return { test, expect: base.expect };
}
