import libraryConfig from '@arki/eslint-config/library';

export default [
  ...libraryConfig,
  {
    // Prettier owns number formatting and prints hex digits in lowercase; this rule demands uppercase.
    files: ['src/**/*.ts'],
    rules: {
      'unicorn/number-literal-case': 'off',
    },
  },
];
