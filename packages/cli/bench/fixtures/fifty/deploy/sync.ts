import { z } from 'zod';

import { defineCommand } from '../../../../src/index.js';
import { commandDescribe } from '../../tree-data.js';

export default defineCommand({
  describe: commandDescribe('deploy', 'sync'),
  input: z.object({
    maxBatches: z.int().min(1).optional().describe('Stop after this many batches'),
    yes: z.boolean().default(false).describe('Skip the confirmation'),
  }),
  args: ['maxBatches'],
  run: async ({ input }) => {
    const { handle } = await import('../../handler.js');
    return handle('deploy sync', input);
  },
});
