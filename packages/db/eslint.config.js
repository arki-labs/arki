import failure from '@arki/failure/eslint';
import baseConfig from '@arki/eslint-config/base';

/** @type {import('typescript-eslint').Config} */
export default [
  {
    ignores: ['dist/**'],
  },
  ...baseConfig,
  failure.configs.recommended,
];
