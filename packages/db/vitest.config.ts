import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: './.cache/.vitest',
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // Most files boot an in-memory PGlite (a WASM Postgres, ~1 s alone) and one
    // starts a Postgres container. Run side by side on a busy machine, the
    // first boot alone can pass the 5 s default.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
