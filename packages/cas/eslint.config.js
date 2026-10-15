import { library } from '@arki/eslint-config/library';

// `src/test-support.ts` is Node-only test scaffolding (CPU time for the time bounds); every entry is portable.
export default library({ adapters: ['src/node/**', 'src/test-support.ts'] });
