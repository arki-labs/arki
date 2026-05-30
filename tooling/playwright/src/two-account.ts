import { test as base, type Page } from '@playwright/test';

import { createAuthGlobalSetup, type CreateAuthGlobalSetupOptions } from './auth';

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
 * } from '@arki/playwright-config/auth';
 *
 * export default createTwoAccountGlobalSetup({
 *   baseUrl: 'http://localhost:5197',
 *   emails: { a: 'a@novelette.test', b: 'b@novelette.test' },
 *   authStatePaths: {
 *     a: resolveAuthStatePath(import.meta.url, '.auth', 'account-a.json'),
 *     b: resolveAuthStatePath(import.meta.url, '.auth', 'account-b.json'),
 *   },
 * });
 *
 * @todo(issue-11) Move to `@arki/auth/testing/playwright` together with
 *   `createAuthGlobalSetup` + `createAuthenticatedTest`. The migration is
 *   a verbatim move + one-line re-export update; consumers (this file's
 *   importers) flip their import path in the same commit.
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
 *
 * @todo(issue-11) Move to `@arki/auth/testing/playwright`.
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
