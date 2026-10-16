import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: './.cache/.vitest',
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Docker Postgres (`test:pg`) and live object stores (`test:live`) run on their own,
    // and fail loud there when their backend is missing.
    exclude: ['**/node_modules/**', 'src/**/*.pg.test.ts', 'src/**/*.live.test.ts'],
  },
});
