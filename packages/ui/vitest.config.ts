import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import sharedConfig from '@arki/vitest-config';

const resizablePanelsBrowserBuild = join(
  dirname(createRequire(import.meta.url).resolve('react-resizable-panels/package.json')),
  'dist/react-resizable-panels.browser.development.esm.js',
);

export default defineConfig({
  ...sharedConfig,
  plugins: [react()],
  test: {
    ...sharedConfig.test,
    environment: 'jsdom',
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    // The tests run in a DOM, so they need the browser build: the node build of react-resizable-panels
    // never saves or restores a layout, which hides the saved-layout bugs the tests guard against.
    alias: [{ find: /^react-resizable-panels$/, replacement: resizablePanelsBrowserBuild }],
  },
});
