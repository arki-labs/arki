import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import sharedConfig from '@arki/vitest-config';

export default defineConfig({
  ...sharedConfig,
  plugins: [react()],
  test: {
    ...sharedConfig.test,
    environment: 'jsdom',
    include: ['src/__tests__/**/*.test.tsx'],
  },
});
