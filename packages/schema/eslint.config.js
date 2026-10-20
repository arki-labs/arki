import failure from '@arki/failure/eslint';
import { library } from '@arki/eslint-config/library';

export default [
  ...library(),
  failure.configs.recommended,
  {
    // This package is the one place allowed to import `@standard-schema/spec`; every other package imports from here.
    files: ['src/**/*.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  },
];
