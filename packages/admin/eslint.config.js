import { library } from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

// `src/server.ts` is the Node-only `./server` entry (node:crypto); `src/dot.ts` needs the optional `@arki/http` peer;
// `src/pg.ts` needs the optional `drizzle-orm` peer; every other entry is portable.
export default [...library({ adapters: ['src/server.ts', 'src/dot.ts', 'src/pg.ts'] }), failure.configs.recommended];
