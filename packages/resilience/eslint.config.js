import libraryConfig from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

export default [
  ...libraryConfig,
  failure.configs.recommended,
  {
    // Compile-only negative expressions are never executed; their discarded values test the compiler contract.
    files: ['src/types.test-d.ts'],
    rules: { 'failure/must-use': 'off' },
  },
];
