import { createPlaywrightConfig } from '@arki/playwright-config';

// Drive the Playwright baseURL from the same env var + literal fallback as
// vite.config.ts (docs/conventions/ports.md), so the readiness probe and the
// test target always agree with the dev server — including when the port is
// overridden per-shell with `ARKI_DEV_PORT=NNNN`. A server already listening
// on that port (a built `.output/server/index.mjs`) is reused outside CI.
const port = process.env.ARKI_DEV_PORT ?? 5181;

export default createPlaywrightConfig({
  baseURL: `http://localhost:${port}`,
});
