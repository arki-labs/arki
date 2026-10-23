import { defineConfig } from 'vitest/config';

/** `bun run test:pg` and `bun run test:redis`: the backends on real servers in Docker. Fails (never skips) when Docker is missing. */
export default defineConfig({
  cacheDir: './.cache/.vitest',
  test: {
    environment: 'node',
    include: ['src/**/*.pg.test.ts', 'src/**/*.redis.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
