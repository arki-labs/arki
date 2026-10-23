import { library } from '@arki/eslint-config/library';

// `./dot` runs inside a Dot server app and reads `process.env` there.
export default library({ adapters: ['src/dot/**'] });
