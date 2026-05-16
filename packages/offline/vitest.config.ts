import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: './.cache/.vitest',
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      '__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
    ],
    typecheck: {
      enabled: true,
      include: [
        '__tests__/**/*.test-d.{ts,tsx}',
      ],
    },
  },
});
