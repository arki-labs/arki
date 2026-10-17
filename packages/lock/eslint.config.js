import { library } from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

export default [
  ...library({
    adapters: ['src/pg/**', 'src/redis/**', 'src/file/**', 'src/dot/**', 'src/testing/**'],
  }),
  // `failure/must-use` and `failure/no-blind-accept`: a returned failure is never thrown away or accepted unchecked.
  failure.configs.recommended,
];
