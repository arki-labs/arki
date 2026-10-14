import { library } from '@arki/eslint-config/library';

// `src/node` is the Node host (files, processes, bundling) and `src/cli.ts` its command line.
export default library({ adapters: ['src/node/**', 'src/cli.ts'] });
