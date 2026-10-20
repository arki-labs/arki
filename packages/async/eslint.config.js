import { library } from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

export default [
  ...library(),
  failure.configs.recommended,
  {
    // Compile-only negative fixtures deliberately discard invalid expressions; their bodies never run.
    files: ['src/scope.types.test.ts'],
    rules: { 'failure/must-use': 'off' },
  },
  {
    // Bootstrap failure schemas use the external protocol without a schema runtime dependency.
    files: ['src/errors.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@standard-schema/spec',
              allowTypeImports: true,
              message: 'Scope failure schemas use Standard Schema types only.',
            },
          ],
        },
      ],
    },
  },
];
