import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: './.cache/.vitest',
  test: {
    // Fake values so the env schema validates; tests never skip validation.
    env: {
      AUTH_SECRET: 'test-secret-value-0123456789abcdef0123456789',
    },
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
  },
});
