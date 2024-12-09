import { type UserWorkspaceConfig } from 'vitest/config';

export default {
  test: {
    globals: true,
    environment: 'node',
  },
} satisfies UserWorkspaceConfig;
