import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The tsconfig keeps JSX for the app's bundler; tests need it compiled.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
