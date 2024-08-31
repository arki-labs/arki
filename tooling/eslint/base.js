/** @type {import("eslint").Linter.Config} */
const config = {
  extends: [
    'plugin:turbo/recommended',
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended-type-checked',
    'plugin:@typescript-eslint/stylistic-type-checked',
    'plugin:unicorn/recommended',
    'plugin:drizzle/recommended',
    'plugin:regexp/recommended',
  ],
  env: {
    es2022: true,
    es2024: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: true,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: [
    '@typescript-eslint',
    'turbo',
    'import',
    'unused-imports',
    'drizzle',
    'regexp',
    'unicorn',
    'eslint-plugin-tsdoc',
    'eslint-plugin-eslint-comments',
    'check-file',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': [
      'warn',
      { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
    ],
    '@typescript-eslint/no-misused-promises': [2, { checksVoidReturn: { attributes: false } }],
    'unicorn/prevent-abbreviations': 'off',
    'unicorn/filename-case': [
      'error',
      {
        cases: {
          camelCase: true,
          kebabCase: true,
        },
      },
    ],
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
    'import/consistent-type-specifier-style': ['error', 'prefer-inline'],
  },
  ignorePatterns: [
    '**/.eslintrc.cjs',
    '**/*.config.js',
    '**/*.config.cjs',
    '**/tooling/**',
    'pnpm-lock.yaml',
    '**/*_snapshot.json',
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/build/**',
    '**/.git/**',
    '**/.next/**',
    '**/workbox-*.js',
    '**/public/**',
    '!.eslintrc.js',
  ],
  reportUnusedDisableDirectives: true,
};

// eslint-disable-next-line unicorn/prefer-module
module.exports = config;
