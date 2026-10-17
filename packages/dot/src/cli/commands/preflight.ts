/** `dot _preflight`: one preflight boot in a fresh process, for `dot dev`. Always succeeds; the report says how the boot went. */
import { z } from 'zod';

import { defineCommand } from '@arki/cli';

import { runPreflightChild } from '../preflight-child.js';

export default defineCommand({
  describe: 'Boot the app once and report it as JSON (the preflight of dot dev)',
  input: z.object({
    app: z.string().optional().describe('App file (default: discovery; a `dev` export wins)'),
    cwd: z.string().optional().describe('Project directory (default: current)'),
  }),
  effects: 'write',
  hidden: true,
  run: ({ input }) => runPreflightChild(input),
});
