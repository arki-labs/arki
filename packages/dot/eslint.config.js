import failure from '@arki/failure/eslint';
import { library } from '@arki/eslint-config/library';

export default [
  // `src/cli/**` is the Node-only `dot` binary (`./cli` entry); `src/orpc.ts` is the optional `@orpc/server` adapter.
  ...library({ adapters: ['src/cli/**', 'src/orpc.ts'] }),
  failure.configs.recommended,
  {
    // Tests are typechecked against ES2022, which has no `toSorted`.
    files: ['src/**/*.test.ts'],
    rules: { 'unicorn/no-array-sort': 'off' },
  },
];
