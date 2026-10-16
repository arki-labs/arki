import { defineConfig } from 'vitest/config';

/** `bun run test:live`: signed-upload conformance on a real S3 or R2 bucket. Fails (never skips) without `ARKI_FS_LIVE_*`. */
export default defineConfig({
  cacheDir: './.cache/.vitest',
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.live.test.ts'],
    testTimeout: 30_000,
  },
});
