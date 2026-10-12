import baseConfig from '@arki/eslint-config/base';

const runtimeOnly = [
  { group: ['node:*'], message: 'Node builtins are not available in browsers or Deno.' },
  { group: ['bun', 'bun:*'], message: 'Bun builtins are not available elsewhere.' },
];
const dotOnlyInBridge = {
  group: ['@arki/dot', '@arki/dot/*'],
  message: '`@arki/dot` is an optional peer. Only `src/dot.ts` may import it, so the core entry loads without it.',
};
const orpcOnlyInAdapter = {
  group: ['@orpc/*'],
  message: '`@orpc/server` is an optional peer. Only `src/orpc.ts` may import it, so the core entry loads without it.',
};
const noFeaturePackage = {
  group: ['@arki/feature', '@arki/feature/*'],
  message: 'Feature slices are read by shape. `@arki/feature` must not become a dependency of the journal.',
};

/** @type {import('typescript-eslint').Config} */
export default [
  {
    ignores: ['dist/**'],
  },
  ...baseConfig,
  {
    // This package runs in Node, Bun, Deno, browsers and React Native.
    // Only web-standard globals are allowed; no runtime-specific builtins.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/test-support.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...runtimeOnly, dotOnlyInBridge, orpcOnlyInAdapter, noFeaturePackage],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Not available in browsers.' },
        { name: 'Buffer', message: 'Not available in browsers or Deno.' },
        { name: 'require', message: 'ESM only.' },
        { name: '__dirname', message: 'ESM only.' },
      ],
    },
  },
  {
    // The Dot bridge is the one file that may import `@arki/dot`.
    files: ['src/dot.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...runtimeOnly, orpcOnlyInAdapter, noFeaturePackage] }],
    },
  },
  {
    // The oRPC adapter is the one file that may import `@orpc/server`.
    files: ['src/orpc.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...runtimeOnly, dotOnlyInBridge, noFeaturePackage] }],
    },
  },
];
