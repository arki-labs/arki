import baseConfig from '@arki/eslint-config/base';
import failure from '@arki/failure/eslint';

/** @type {import('typescript-eslint').Config} */
export default [
  {
    ignores: ['dist/**'],
  },
  ...baseConfig,
  failure.configs.recommended,
];
