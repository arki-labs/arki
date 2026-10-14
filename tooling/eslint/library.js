import baseConfig from './base.js';

/**
 * Lint preset for cross-runtime `@arki/*` libraries (RFC `arki-structure` §6).
 *
 * The portable entries of a library run in Node, Bun, Deno, browsers and
 * React Native (Hermes). On `src/**` this bans runtime-specific imports and
 * globals, and the ES2023 copying array methods Hermes lacks. Tests and
 * adapter folders (platform code behind a named entry such as `/node`) are
 * exempt.
 *
 * A library's whole `eslint.config.js` is then:
 *
 *   export { default } from '@arki/eslint-config/library';
 */

/** Import patterns the portable entries must not use. Reuse them when a package adds its own import restrictions. */
export const portableImportPatterns = [
  { group: ['node:*'], message: 'Node builtins are not available in browsers or Deno.' },
  { group: ['bun', 'bun:*'], message: 'Bun builtins are not available elsewhere.' },
];

/** Adapter globs exempt from the portable rules unless the package names its own. */
const DEFAULT_ADAPTERS = ['src/node/**'];

/**
 * @param {{ adapters?: string[] }} [options] `adapters`: globs (relative to the package) of platform-specific code,
 *   exempt from the portable rules. Replaces the default `['src/node/**']`.
 */
export function library({ adapters = DEFAULT_ADAPTERS } = {}) {
  return [
    {
      ignores: ['dist/**'],
    },
    ...baseConfig,
    {
      files: ['src/**/*.ts'],
      ignores: ['src/**/*.test.ts', ...adapters],
      rules: {
        'no-restricted-imports': ['error', { patterns: portableImportPatterns }],
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
}

export default library();
