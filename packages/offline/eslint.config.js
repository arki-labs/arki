import baseConfig from '@arki/eslint-config/base';
import failure from '@arki/failure/eslint';

export default [
  ...baseConfig,
  failure.configs.recommended,
  {
    // Compile-only negative expressions are never executed; their discarded values test the compiler contract.
    files: ['__tests__/mutations/operations.test-d.ts'],
    rules: { 'failure/must-use': 'off' },
  },
];
