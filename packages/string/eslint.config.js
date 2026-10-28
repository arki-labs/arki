import libraryConfig from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

export default [
  ...libraryConfig,
  failure.configs.recommended,
  {
    // Prettier owns number formatting and prints hex digits in lowercase; this rule demands uppercase.
    files: ['src/**/*.ts'],
    rules: {
      'unicorn/number-literal-case': 'off',
    },
  },
];
