import { library, portableImportPatterns } from '@arki/eslint-config/library';

/** The optional peers. Only their adapter entries may import them, so `@arki/live` loads without any of them. */
const peersOnlyInAdapters = {
  group: ['drizzle-orm', 'drizzle-orm/*', '@orpc/*', 'react', 'react/*', '@tanstack/*'],
  message: 'An optional peer. Only its adapter entry (`src/drizzle/`, `src/orpc/`, `src/react.ts`) may import it.',
};

const adapters = ['src/drizzle/**', 'src/orpc/**', 'src/react.ts'];

export default [
  ...library({ adapters }),
  {
    // The portable entries (`.`, `/testing`) import no peer.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', ...adapters],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...portableImportPatterns, peersOnlyInAdapters] }],
    },
  },
];
