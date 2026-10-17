import { defineCommand } from '../../command.js';
import { imported } from '../tree.js';

imported('ping-now');

export default defineCommand({
  describe: 'Answer now',
  run: () => [
    { name: 'db', ok: true },
    { name: 'queue', ok: false },
  ],
});
