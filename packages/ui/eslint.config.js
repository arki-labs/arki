import baseConfig from '@arki/eslint-config/base';
import reactConfig from '@arki/eslint-config/react';
import failure from '@arki/failure/eslint';

/** @type {import('typescript-eslint').Config} */
export default [
  {
    ignores: ['dist/**'],
  },
  ...baseConfig,
  ...reactConfig,
  failure.configs.recommended,
];
