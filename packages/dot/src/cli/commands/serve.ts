/** `dot _serve`: the runner `dot dev` spawns without Vite or `--run`. Starts the app until SIGINT/SIGTERM. */
import { z } from 'zod';

import { defineCommand } from '@arki/cli';

import { runServe } from '../serve.js';

export default defineCommand({
  describe: 'Start the app until stopped (the runner of dot dev)',
  input: z.object({
    app: z.string().optional().describe('App file (default: discovery; a `dev` export wins)'),
    cwd: z.string().optional().describe('Project directory (default: current)'),
  }),
  hidden: true,
  run: ({ input, signal }) => runServe({ ...input, signal }),
  render: () => {
    // Nothing to print: the app's own output is the runner output.
  },
});
