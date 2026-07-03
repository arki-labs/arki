/**
 * Minimal DOT app fixture used by the CLI smoke test.
 *
 * Exports a builder that the CLI can `.configure()` (for `dot explain`) or
 * `.boot()` (for `dot doctor`). Stays intentionally tiny — registering a
 * single logger service is enough to exercise the 5-array manifest contract.
 */

import { defineApp, pip } from '../../../index.js';

const logger = pip({
  name: 'logger',
  version: '1.0.0',
  configure: ctx => {
    ctx.registerService('logger', 'logger');
  },
  boot: () => ({
    logger: {
      info: (s: string) => {
        // Intentional console use — fixture only.
        // eslint-disable-next-line no-console
        console.log(s);
      },
    },
  }),
});

export default defineApp('sample').use(logger);
