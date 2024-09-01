/// <reference types="./types.d.ts" />

import * as path from "node:path";
import { includeIgnoreFile } from "@eslint/compat";
import eslint from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import drizzlePlugin from "eslint-plugin-drizzle";
import regexpPlugin from "eslint-plugin-regexp";
import unicornPlugin from "eslint-plugin-unicorn";
import turboPlugin from "eslint-plugin-turbo";
import tseslint from "typescript-eslint";
import unusedImportsPlugin from "eslint-plugin-unused-imports";
import tsdocPlugin from "eslint-plugin-tsdoc";
import eslintCommentsPlugin from "eslint-plugin-eslint-comments";
import checkFilePlugin from "eslint-plugin-check-file";

const ignoreFilePath = path.join(import.meta.dirname, "../../.gitignore")

console.warn('ignoreFilePath', ignoreFilePath)

/**
 * All packages that leverage t3-env should use this rule
 */
export const restrictEnvAccess = tseslint.config(
  { ignores: ["**/env.ts"] },
  {
    files: ["**/*.js", "**/*.ts", "**/*.tsx"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Use `import { env } from '~/env'` instead to ensure validated types.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          name: "process",
          importNames: ["env"],
          message:
            "Use `import { env } from '~/env'` instead to ensure validated types.",
        },
      ],
    },
  },
);

export default tseslint.config(
  // Ignore files not tracked by VCS and any config files
  includeIgnoreFile(ignoreFilePath),
  { ignores: ["**/*.config.*"] },
  {
    files: ["**/*.js", "**/*.ts", "**/*.tsx"],
    plugins: {
      import: importPlugin,
      turbo: turboPlugin,
      'drizzle': drizzlePlugin,
      'regexp':  regexpPlugin,
      'unicorn':  unicornPlugin,
      'unused-imports': unusedImportsPlugin,
      'tsdoc': tsdocPlugin,
      'eslint-comments': eslintCommentsPlugin,
      'check-file': checkFilePlugin,
    },
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    rules: {
      ...drizzlePlugin.configs.recommended.rules,
      ...regexpPlugin.configs.recommended.rules,
      ...unicornPlugin.configs.recommended.rules,
      ...turboPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-misused-promises": [
        2,
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/no-unnecessary-condition": [
        "error",
        {
          allowConstantLoopConditions: true,
        },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      'import/consistent-type-specifier-style': ['error', 'prefer-inline'],
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/filename-case': 'off',
      'unused-imports/no-unused-imports': 'error',
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
