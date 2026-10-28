import { library } from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

// `docs/examples` are standalone snippets outside the tsconfig project.
export default [
  { ignores: ['docs/examples/**'] },
  ...library({ adapters: ['src/node/**'] }),
  failure.configs.recommended,
];
