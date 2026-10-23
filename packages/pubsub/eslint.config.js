import { library } from '@arki/eslint-config/library';

export default library({
  adapters: ['src/poll/**', 'src/pg/**', 'src/redis/**', 'src/testing/**'],
});
