import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fake values so the env schema validates; tests never skip validation.
    env: {
      STRIPE_SECRET_KEY: 'sk_test_fake',
    },
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
