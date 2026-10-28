import { library } from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

export default [
  ...library({
    adapters: ['src/sqlite/**', 'src/pg/**', 'src/redis/**', 'src/testing/**'],
  }),
  failure.configs.recommended,
];
