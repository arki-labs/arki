import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

/** A single `webServer` entry (as opposed to the array-of-entries variant). */
type WebServerConfig = Exclude<PlaywrightTestConfig['webServer'], undefined | null | unknown[]>;

/**
 * Options for customizing the shared Playwright configuration.
 * All fields are optional; sensible defaults are applied for every field.
 */
interface PlaywrightConfigOptions {
  /** Directory containing e2e test files. Defaults to `'./e2e'`. */
  testDir?: string;

  /** Base URL for the application under test. Defaults to `'http://localhost:3000'`. */
  baseURL?: string;

  /** Command to start the dev server. Defaults to `'bun run dev'`. */
  webServerCommand?: string;

  /** URL the dev server listens on (used for health check). Defaults to the baseURL value. */
  webServerUrl?: string;

  /** Timeout for the dev server to become ready, in milliseconds. Defaults to `120_000`. */
  webServerTimeout?: number;

  /**
   * Additional Playwright projects (browsers) beyond the default Chromium.
   * These are appended to the default `[{ name: 'chromium', use: devices['Desktop Chrome'] }]`.
   */
  extraProjects?: PlaywrightTestConfig['projects'];

  /**
   * Additional `use` options merged on top of the defaults.
   * Defaults include `trace: 'on-first-retry'` and `screenshot: 'only-on-failure'`.
   */
  use?: PlaywrightTestConfig['use'];

  /**
   * Any other Playwright config overrides.
   * These are spread last, allowing full escape-hatch customization.
   */
  overrides?: Omit<PlaywrightTestConfig, 'testDir' | 'use' | 'projects' | 'webServer'>;

  /**
   * Additional web servers (e.g. a background worker) started alongside the
   * primary dev server. Appended after the primary entry; Playwright waits
   * for each `url` before running tests. Defaults to `[]` — every existing
   * consumer that omits this option keeps the identical single-object
   * `webServer` behavior as before (zero behavior change).
   */
  extraWebServers?: WebServerConfig[];
}

/**
 * Creates a Playwright test configuration with sensible monorepo defaults.
 *
 * @example
 * ```typescript
 * // Minimal usage (all defaults)
 * import { createPlaywrightConfig } from '@arki/playwright-config';
 * export default createPlaywrightConfig();
 *
 * // With customization
 * import { createPlaywrightConfig } from '@arki/playwright-config';
 * export default createPlaywrightConfig({
 *   baseURL: 'http://localhost:4000',
 *   extraProjects: [
 *     { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
 *   ],
 * });
 * ```
 */
function createPlaywrightConfig(options: PlaywrightConfigOptions = {}) {
  const {
    testDir = './e2e',
    baseURL = 'http://localhost:3000',
    webServerCommand = 'bun run dev',
    webServerUrl,
    webServerTimeout = 120_000,
    extraProjects = [],
    use = {},
    overrides = {},
    extraWebServers = [],
  } = options;

  const resolvedWebServerUrl = webServerUrl ?? baseURL;

  return defineConfig({
    testDir,
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: 'html',
    use: {
      baseURL,
      trace: 'on-first-retry',
      screenshot: 'only-on-failure',
      ...use,
    },
    projects: [
      {
        name: 'chromium',
        use: { ...devices['Desktop Chrome'] },
      },
      ...extraProjects,
    ],
    webServer:
      extraWebServers.length > 0
        ? [
            {
              command: webServerCommand,
              url: resolvedWebServerUrl,
              reuseExistingServer: !process.env.CI,
              timeout: webServerTimeout,
            },
            ...extraWebServers,
          ]
        : {
            command: webServerCommand,
            url: resolvedWebServerUrl,
            reuseExistingServer: !process.env.CI,
            timeout: webServerTimeout,
          },
    ...overrides,
  });
}

/**
 * Run policy for suites on a real stack (`e2eConfig` from `@arki/testing/e2e`): one server and
 * one database per worker, so workers are cheap to add. Retries are visible in the report; a test
 * that passes only on a retry is flaky, not green.
 */
const e2ePolicy = {
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 4,
  reporter: [['list'], ['html', { open: 'never' }]],
} satisfies PlaywrightTestConfig;

export { createPlaywrightConfig, e2ePolicy, type PlaywrightConfigOptions };
