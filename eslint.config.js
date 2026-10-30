import failure from '@arki/failure/eslint';
import baseConfig from '@arki/eslint-config/base';

/** @type {import('typescript-eslint').Config} */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/build/**',
      '**/.cache/**',
      '**/coverage/**',
    ],
  },
  ...baseConfig,
  failure.configs.recommended,
];
