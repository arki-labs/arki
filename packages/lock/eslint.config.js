import { library } from '@arki/eslint-config/library';

export default library({
  adapters: ['src/pg/**', 'src/redis/**', 'src/file/**', 'src/dot/**', 'src/testing/**'],
});
