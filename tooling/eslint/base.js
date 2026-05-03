/// <reference types="./types.d.ts" />

import * as path from 'node:path';
import { includeIgnoreFile } from '@eslint/compat';
import eslint from '@eslint/js';
import checkFilePlugin from 'eslint-plugin-check-file';
import drizzlePlugin from 'eslint-plugin-drizzle';
import eslintCommentsPlugin from 'eslint-plugin-eslint-comments';
import importPlugin from 'eslint-plugin-import';
import regexpPlugin from 'eslint-plugin-regexp';
import tsdocPlugin from 'eslint-plugin-tsdoc';
import turboPlugin from 'eslint-plugin-turbo';
import unicornPlugin from 'eslint-plugin-unicorn';
import unusedImportsPlugin from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

let ignoreFilePath = import.meta.dirname ? path.join(import.meta.dirname, '../../.gitignore') : undefined;

const ignoreFilePathConfig = ignoreFilePath && path.isAbsolute(ignoreFilePath) ? includeIgnoreFile(ignoreFilePath) : {};

/**
 * All packages that leverage t3-env should use this rule
 */
export const restrictEnvAccess = tseslint.config(
  { ignores: ['**/env.ts'] },
  {
    files: ['**/*.js', '**/*.ts', '**/*.tsx'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: "Use `import { env } from '~/env'` instead to ensure validated types.",
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          name: 'process',
          importNames: ['env'],
          message: "Use `import { env } from '~/env'` instead to ensure validated types.",
        },
      ],
    },
  },
);

export default tseslint.config(
  // Ignore files not tracked by VCS and any config files
  ignoreFilePathConfig,
  {
    ignores: [
      '**/*.config.*',
      '**/tooling/eslint/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/.cache/**',
      '**/.git/**',
      '**/.github/**',
      '**/.vscode/**',
      '**/dist/**',
    ],
  },
  {
    files: ['**/*.js', '**/*.ts', '**/*.tsx'],
    plugins: {
      import: importPlugin,
      turbo: turboPlugin,
      drizzle: drizzlePlugin,
      regexp: regexpPlugin,
      unicorn: unicornPlugin,
      'unused-imports': unusedImportsPlugin,
      tsdoc: tsdocPlugin,
      'eslint-comments': eslintCommentsPlugin,
      'check-file': checkFilePlugin,
    },
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylistic,
    ],
    rules: {
      ...drizzlePlugin.configs.recommended.rules,
      ...regexpPlugin.configs.recommended.rules,
      ...unicornPlugin.configs.recommended.rules,
      ...turboPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-misused-promises': [2, { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/no-unnecessary-condition': [
        'warn',
        {
          allowConstantLoopConditions: true,
        },
      ],
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/filename-case': 'off',
      'unicorn/prefer-string-raw': 'off', // This causes issues with Next.js
      'unicorn/no-null': 'off',
      'unicorn/prefer-ternary': 'off',
      'unicorn/prefer-dom-node-remove': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unicorn/prefer-global-this': 'off',
      'unicorn/no-nested-ternary': 'off',
      'unicorn/no-array-reduce': 'off',
      'unicorn/no-process-exit': 'off',
      'unicorn/consistent-function-scoping': 'warn',
      'unicorn/text-encoding-identifier-case': 'warn',
      'unicorn/no-abusive-eslint-disable': 'warn',
      'unicorn/prefer-native-coercion-functions': 'off',
      /**
       * Disallow expressions where the operation doesn't affect the value.
       *
       * 🚫 Not fixable
       * https://eslint.org/blog/2022/07/interesting-bugs-caught-by-no-constant-binary-expression/
       */
      'no-constant-binary-expression': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    linterOptions: { reportUnusedDisableDirectives: true },
    languageOptions: { parserOptions: { projectService: true } },
  },
);
