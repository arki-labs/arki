import { library } from '@arki/eslint-config/library';

export default [
  ...library(),
  {
    // This package is the one place allowed to import `@standard-schema/spec`; every other package imports from here.
    files: ['src/**/*.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  },
];
