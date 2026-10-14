import { library } from '@arki/eslint-config/library';

// `src/server.ts` is the Node-only `./server` entry (node:crypto); `src/dot.ts` needs the optional `@arki/http` peer; every other entry is portable.
export default library({ adapters: ['src/server.ts', 'src/dot.ts'] });
