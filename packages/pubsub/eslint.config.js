import { library } from '@arki/eslint-config/library';

export default library({
  adapters: ['src/sqlite/**', 'src/pg/**', 'src/redis/**', 'src/testing/**'],
});
