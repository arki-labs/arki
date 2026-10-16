import { createPlaywrightConfig } from '@arki/playwright-config';

const sharedConfig = createPlaywrightConfig({
  testDir: '.',
  overrides: {
    globalSetup: './global-setup.ts',
    // One worker, one database, one app server: the restart spec kills the server the others use.
    fullyParallel: false,
    workers: 1,
    timeout: 60_000,
    reporter: [['list'], ['html', { open: 'never' }]],
  },
});

// The app server is a fixture (`fixtures.ts`), not a `webServer`: a spec has to kill and restart
// it, which Playwright's `webServer` cannot do. The fixture also sets `baseURL` to its port.
export default { ...sharedConfig, webServer: undefined };
