import { library } from '@arki/eslint-config/library';

// `src/testing.ts` runs a subprocess, so it is the one Node-only entry.
export default library({ adapters: ['src/testing.ts'] });
