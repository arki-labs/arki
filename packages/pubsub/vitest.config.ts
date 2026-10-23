import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: './.cache/.vitest',
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // The Postgres and Redis containers run on their own (`test:pg`, `test:redis`)
    // and fail loud there when Docker is missing.
    exclude: ['**/node_modules/**', 'src/**/*.pg.test.ts', 'src/**/*.redis.test.ts'],
    // Type-level tests: `*.test-d.ts` files, checked by tsc through vitest.
    typecheck: { enabled: true, include: ['src/**/*.test-d.ts'] },
    // PGlite (a WASM Postgres) boots in about a second alone, longer on a busy machine.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
