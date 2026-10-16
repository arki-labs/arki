import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: './.cache/.vitest',
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Type-level tests: `*.test-d.ts` files, checked by tsc through vitest.
    typecheck: { enabled: true, include: ['src/**/*.test-d.ts'] },
  },
});
