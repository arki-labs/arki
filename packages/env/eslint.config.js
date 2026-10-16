import { library } from '@arki/eslint-config/library';

// `docs/examples` are standalone snippets outside the tsconfig project.
export default [{ ignores: ['docs/examples/**'] }, ...library({ adapters: ['src/dot.ts'] })];
