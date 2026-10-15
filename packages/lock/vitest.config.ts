import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: './.cache/.vitest',
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // Type-level tests: `*.test-d.ts` files, checked by tsc through vitest.
    typecheck: { enabled: true, include: ['src/**/*.test-d.ts'] },
    // Real Postgres and Redis containers start in some suites; the first boot
    // alone can pass the 5 s default.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
