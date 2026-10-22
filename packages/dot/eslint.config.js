import { library } from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

export default [
  // `bin/dot.js` is a two-line shim that runs `dist/cli/index.js`; it is outside the TS project.
  { ignores: ['bin/**'] },
  // `src/cli/**` is the Node-only `dot` binary (`./cli` entry); `src/orpc.ts` is the optional `@orpc/server` adapter;
  // `src/vite.ts` is the optional Vite plugin (`./vite` entry), Node-only like the CLI it reuses.
  ...library({ adapters: ['src/cli/**', 'src/orpc.ts', 'src/vite.ts'] }),
  failure.configs.recommended,
  {
    // Tests are typechecked against ES2022, which has no `toSorted`.
    files: ['src/**/*.test.ts'],
    rules: { 'unicorn/no-array-sort': 'off' },
  },
];
