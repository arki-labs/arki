import { library, portableImportPatterns } from '@arki/eslint-config/library';

const dotOnlyInBridge = {
  group: ['@arki/dot', '@arki/dot/*'],
  message: '`@arki/dot` is an optional peer. Only `src/dot.ts` may import it, so the core entry loads without it.',
};
const orpcOnlyInAdapter = {
  group: ['@orpc/*'],
  message: '`@orpc/server` is an optional peer. Only `src/orpc.ts` may import it, so the core entry loads without it.',
};

// `src/dot.ts`, `src/orpc.ts` and `src/foreman/` are the adapters; `src/test-support.ts` is test scaffolding.
export default [
  ...library({ adapters: ['src/dot.ts', 'src/orpc.ts', 'src/foreman/*.ts', 'src/test-support.ts'] }),
  {
    // The core may not import the optional peers (features live in `@arki/dot/feature`).
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/dot.ts', 'src/orpc.ts', 'src/foreman/*.ts', 'src/test-support.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...portableImportPatterns, dotOnlyInBridge, orpcOnlyInAdapter] },
      ],
    },
  },
  {
    // The Dot bridge is the one file that may import `@arki/dot`.
    files: ['src/dot.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...portableImportPatterns, orpcOnlyInAdapter] },
      ],
    },
  },
  {
    // The oRPC adapter is the one file that may import `@orpc/server`.
    files: ['src/orpc.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...portableImportPatterns, dotOnlyInBridge] }],
    },
  },
];
