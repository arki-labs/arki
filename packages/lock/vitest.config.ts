import { defineConfig } from 'vitest/config';

const source = (path: string) => new URL(path, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@arki\/lock$/, replacement: source('./src/index.ts') },
      { find: /^@arki\/lock\/memory$/, replacement: source('./src/memory.ts') },
    ],
  },
  cacheDir: './.cache/.vitest',
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'examples/**/*.test.ts'],
    // Type-level tests: `*.test-d.ts` files, checked by tsc through vitest.
    typecheck: { enabled: true, include: ['src/**/*.test-d.ts'] },
    // Real Postgres and Redis containers start in some suites; the first boot
    // alone can pass the 5 s default.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
