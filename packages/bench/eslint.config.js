import baseConfig from '@arki/eslint-config/base';

/** @type {import('typescript-eslint').Config} */
export default [
  {
    // bench/ holds suites, run by arki-bench (not part of the TypeScript project, like every package's bench/).
    ignores: ['dist/**'],
  },
  ...baseConfig,
  {
    // The core (spec, engine, statistics, renderers) runs wherever a benchmark
    // runs: Node, Bun, Deno, browsers and React Native. Only web-standard
    // globals; host features (files, processes, bundling) live in src/node/.
    files: ['src/core/**/*.ts', 'src/index.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'Core runs in browsers and Hermes; put host code in src/node/.' },
            { group: ['bun', 'bun:*'], message: 'Core runs in browsers and Hermes; put host code in src/node/.' },
            { group: ['../node/*', '../node'], message: 'Core must not depend on the Node host.' },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        ...['toSorted', 'toReversed', 'toSpliced'].map(property => ({
          property,
          message: 'Missing on Hermes (React Native). Copy the array, then sort/reverse/splice it.',
        })),
      ],
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
