import { library, portableImportPatterns } from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

const dotOnlyInBridge = {
  group: ['@arki/dot', '@arki/dot/*'],
  message: '`@arki/dot` is an optional peer. Only `src/dot.ts` may import it, so the core entry loads without it.',
};
const kurrentOnlyInAdapter = {
  group: ['@kurrent/*'],
  message:
    '`@kurrent/kurrentdb-client` is an optional peer. Only `src/kurrentdb.ts` may import it, so the core entry loads without it.',
};
const orpcOnlyInAdapter = {
  group: ['@orpc/*'],
  message: '`@orpc/server` is an optional peer. Only `src/orpc.ts` may import it, so the core entry loads without it.',
};

// `src/dot.ts`, `src/orpc.ts`, `src/kurrentdb.ts`, `src/event-map.ts` (Node-only: it reads the filesystem) and `src/foreman/` are the adapters; `src/test-support.ts` and `src/fixtures/` are test scaffolding.
export default [
  ...library({
    adapters: [
      'src/dot.ts',
      'src/orpc.ts',
      'src/kurrentdb.ts',
      'src/event-map.ts',
      'src/foreman/*.ts',
      'src/test-support.ts',
    ],
  }),
  // `failure/must-use` and `failure/no-blind-accept`: a returned failure is never thrown away or accepted unchecked.
  failure.configs.recommended,
  {
    // The core may not import the optional peers (features live in `@arki/dot/feature`).
    files: ['src/**/*.ts'],
    ignores: [
      'src/**/*.test.ts',
      // Type tests ship nowhere either (tsconfig.build.json excludes them), so they may import the peers.
      'src/**/*.test-d.ts',
      'src/dot.ts',
      'src/orpc.ts',
      'src/kurrentdb.ts',
      'src/event-map.ts',
      'src/foreman/*.ts',
      'src/test-support.ts',
      'src/fixtures/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...portableImportPatterns, dotOnlyInBridge, orpcOnlyInAdapter, kurrentOnlyInAdapter] },
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
    // The KurrentDB adapter is the one file that may import `@kurrent/kurrentdb-client`.
    files: ['src/kurrentdb.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...portableImportPatterns, dotOnlyInBridge, orpcOnlyInAdapter] }],
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
