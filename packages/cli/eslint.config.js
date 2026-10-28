import { library } from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

// The package runs on Node, Bun and Deno (package.json "arki.runtimes"). These files use their shared Node APIs:
// `src/parse.ts` (node:util parseArgs), `src/input.ts` (node:fs, for --input-file), `src/run.ts` (the process boundary).
export default [...library({ adapters: ['src/parse.ts', 'src/input.ts', 'src/run.ts'] }), failure.configs.recommended];
