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
      // ES2023 copying array methods are missing on Hermes V1 (React Native 0.86).
      'no-restricted-properties': [
        'error',
        ...['toSorted', 'toReversed', 'toSpliced'].map(property => ({
          property,
          message: 'Missing on Hermes (React Native). Copy the array, then sort/reverse/splice it.',
        })),
      ],
      // The copy-then-sort pattern above is deliberate.
      'unicorn/no-array-sort': 'off',
      'unicorn/no-array-reverse': 'off',
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
