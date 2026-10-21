import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';

import base from '@arki/vitest-config';

export default mergeConfig(
  base,
  defineConfig({
    // Matches the app's `~/` import alias, so tests can import app modules.
    resolve: { alias: { '~': fileURLToPath(new URL('src', import.meta.url)) } },
    test: {
      include: ['src/**/*.test.{ts,tsx}'],
      exclude: ['node_modules', 'dist', '.output', 'e2e'],
    },
  }),
);
