import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Property tests run hundreds of cases; on a loaded machine they wait for a CPU, so 5 s is too tight.
    testTimeout: 30_000,
  },
});
