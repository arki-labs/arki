import baseConfig from '@arki/eslint-config/base';
import failure from '@arki/failure/eslint';

/** @type {import('typescript-eslint').Config} */
export default [
  {
    ignores: ['dist/**'],
  },
  ...baseConfig,
  // `failure/must-use` and `failure/no-blind-accept`: a returned failure is never thrown away or accepted unchecked.
  failure.configs.recommended,
];
