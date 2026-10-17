/**
 * `e2eConfig({ stack })` — the Playwright config for an app on its real stack. The capability
 * lives here; the policy (workers, retries, reporters) comes from `@arki/playwright-config`.
 */
import type { PlaywrightTestConfig } from '@playwright/test';

export type E2EConfigOptions = {
  /** Path to the app's `globalSetup` file, which default-exports `stackSetup(stack, ...)`. */
  readonly globalSetup: string;
  /** Policy from `tooling/playwright`, spread under the stack-specific settings. */
  readonly policy?: PlaywrightTestConfig;
  readonly testDir?: string;
  /** Which files are specs. Default Playwright's `*.spec.ts`. */
  readonly testMatch?: PlaywrightTestConfig['testMatch'];
  /** Time for one test. Default 3 minutes. */
  readonly testTimeoutMs?: number;
};

export function e2eConfig(options: E2EConfigOptions): PlaywrightTestConfig {
  return {
    ...options.policy,
    testDir: options.testDir ?? './e2e',
    ...(options.testMatch === undefined ? {} : { testMatch: options.testMatch }),
    globalSetup: options.globalSetup,
    // The stack is real, so the server and the model are slow once per worker, not per test.
    timeout: options.testTimeoutMs ?? 180_000,
    use: { ...options.policy?.use, trace: 'on-first-retry', screenshot: 'only-on-failure' },
  };
}
