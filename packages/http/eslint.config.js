import baseConfig from '@arki/eslint-config/base';
import failure from '@arki/failure/eslint';

/** @type {import('typescript-eslint').Config} */
export default [
  {
    ignores: ['dist/**'],
  },
  ...baseConfig,
  failure.configs.recommended,
  {
    // Lint owns source, examples and benchmark programs; the build/typecheck project keeps its existing scope.
    languageOptions: {
      parserOptions: { projectService: false, project: ['./tsconfig.lint.json'], tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // Compile-only negative expressions are never executed; their discarded values test the compiler contract.
    files: ['src/tests/client.types.test.ts'],
    rules: { 'failure/must-use': 'off' },
  },
];
