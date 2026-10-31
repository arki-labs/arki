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
  {
    // Copy, then sort or reverse: ES2023 `toSorted`/`toReversed` are missing on Hermes V1 and in the
    // ES2022 lib this package compiles against (the same choice as `@arki/eslint-config/library`).
    rules: {
      'unicorn/no-array-sort': 'off',
      'unicorn/no-array-reverse': 'off',
      // An explicit `undefined` argument is often required by the callee's type (`mockResolvedValue(undefined)`).
      'unicorn/no-useless-undefined': ['error', { checkArguments: false }],
    },
  },
];
