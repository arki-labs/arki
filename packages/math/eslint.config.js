import baseConfig from '@arki/eslint-config/base';

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
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'Node builtins are not available in browsers or Deno.' },
            { group: ['bun', 'bun:*'], message: 'Bun builtins are not available elsewhere.' },
          ],
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
];
