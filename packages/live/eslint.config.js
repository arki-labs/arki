import { library, portableImportPatterns } from '@arki/eslint-config/library';

/** The optional peers. Only their adapter entries may import them, so `@arki/live` loads without any of them. */
const peersOnlyInAdapters = {
  group: [
    '@arki/db',
    '@arki/db/*',
    '@arki/dot',
    '@arki/dot/*',
    '@arki/http',
    '@arki/http/*',
    'drizzle-orm',
    'drizzle-orm/*',
    '@orpc/*',
    'react',
    'react/*',
    '@tanstack/*',
  ],
  message:
    'An optional peer. Only its adapter entry (`src/dot.ts`, `src/drizzle/`, `src/http.ts`, `src/orpc/`, `src/pg/`, `src/react.ts`) may import it.',
};

const adapters = ['src/dot.ts', 'src/drizzle/**', 'src/http.ts', 'src/orpc/**', 'src/pg/**', 'src/react.ts'];

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
