import { closeSync } from 'node:fs';
import process from 'node:process';

import { createLogging } from '../../src/core/logging.js';
import { stdout } from '../../src/node/index.js';

const logging = createLogging();
const handle = logging.configure({ channels: { out: stdout() }, default: { level: 'info', channels: ['out'] } });
closeSync(1);
logging.getLogger().info('observation must not terminate the app');
if (process.argv.at(-1) === 'exit') process.exit(0);
setImmediate(() => {
  void handle.close().then(() => process.stderr.write('survived\n'));
});
