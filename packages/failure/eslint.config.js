import failure from '@arki/failure/eslint';
import { library } from '@arki/eslint-config/library';

export default [
  ...library(),
  failure.configs.recommended,
  {
    // Failure is the acyclic foundation; canonical spec types have no runtime edge.
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@standard-schema/spec',
              allowTypeImports: true,
              message: 'Only type imports belong in the failure foundation.',
            },
          ],
        },
      ],
    },
  },
];
