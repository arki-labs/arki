import baseConfig from '@arki/eslint-config/base';

/** @type {import('typescript-eslint').Config} */
export default [
  {
    ignores: ['dist/**'],
  },
  ...baseConfig,
  {
    // This package runs in Node, Bun, Deno, browsers and React Native (Hermes).
    // Only web-standard globals are allowed; no runtime-specific builtins.
    // `src/runtime.test.ts` additionally rejects post-ES2022 built-ins.
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
  {
    // Prettier owns number formatting and prints hex digits in lowercase; this rule demands uppercase.
    files: ['src/**/*.ts'],
    rules: {
      'unicorn/number-literal-case': 'off',
    },
  },
];
