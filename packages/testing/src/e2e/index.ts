/**
 * `@arki/testing/e2e` — Playwright end-to-end tests that boot a built app against the real stack: config, setup, story helpers and request holds.
 */
export { e2eConfig, type E2EConfigOptions } from './config.js';
export { SERVER_ROOT_ENV_KEY, stackSetup } from './setup.js';
export { holdRequests, type RequestHold } from './hold.js';
export { ensureBuilt, type ServerOptions } from './server.js';
export { e2eTest, storyFor, type Actor, type Isolation, type StoryBody, type BootableApp, type CronRun, type E2EOptions, type E2EServices, type TestAuth } from './test.js';
