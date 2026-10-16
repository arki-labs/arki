import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: './.cache/.vitest',
  // @arki/ui ships .tsx source with `jsx: preserve`; the sign-in form test loads it.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    // Fake values so the env schema validates; tests never skip validation.
    env: {
      AUTH_SECRET: 'test-secret-value-0123456789abcdef0123456789',
    },
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Flow tests boot an in-memory PGlite each; one file starts a Postgres container.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
