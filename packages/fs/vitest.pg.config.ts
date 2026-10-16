import { defineConfig } from 'vitest/config';

/** `bun run test:pg`: races on a real Postgres in Docker. Fails (never skips) when Docker is missing. */
export default defineConfig({
  cacheDir: './.cache/.vitest',
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.pg.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
