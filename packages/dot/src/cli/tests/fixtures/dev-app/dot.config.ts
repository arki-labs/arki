/**
 * The `dot dev` fixture: a `dev` export with one plain plugin and no
 * database, next to a `default` export that `dot dev` must not pick.
 * Imports the kernel modules directly, like the discover tests do.
 */
import { defineApp } from '../../../../define-app.js';
import { plugin } from '../../../../plugin-contract.js';

const clock = plugin({
  name: 'clock',
  start: () => {
    // The runner's output is under test: one line when the app starts.
    process.stdout.write('dev-app started\n');
  },
});

export const dev = defineApp('dev-app').use(clock);

export default defineApp('dev-app-default').use(clock);
