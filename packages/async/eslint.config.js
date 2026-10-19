import { library } from '@arki/eslint-config/library';

export default [
  ...library(),
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
