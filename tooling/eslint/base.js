/** @type {import("eslint").Linter.Config} */
const config = {
  extends: [
    'turbo',
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended-type-checked',
    'plugin:@typescript-eslint/stylistic-type-checked',
    'plugin:unicorn/recommended',
    'plugin:drizzle/recommended',
    'prettier',
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
  plugins: ['@typescript-eslint', 'import', 'unused-imports', 'drizzle'],
  rules: {
    'turbo/no-undeclared-env-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': [
      'warn',
      { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
    ],
    '@typescript-eslint/no-misused-promises': [2, { checksVoidReturn: { attributes: false } }],
    'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
    'unused-imports/no-unused-imports': 'error',
    'unused-imports/no-unused-vars': [
      'warn',
      { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
    ],
  },
  ignorePatterns: [
    '**/.eslintrc.cjs',
    '**/*.config.js',
    '**/*.config.cjs',
    'pnpm-lock.yaml',
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/build/**',
    '**/.git/**',
    '**/.next/**',
    '**/public/**',
    '!.eslintrc.js',
  ],
  reportUnusedDisableDirectives: true,
};

module.exports = config;
