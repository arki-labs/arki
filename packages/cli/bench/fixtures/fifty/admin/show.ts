import { z } from 'zod';

import { defineCommand } from '../../../../src/index.js';
import { commandDescribe } from '../../tree-data.js';

export default defineCommand({
  describe: commandDescribe('admin', 'show'),
  input: z.object({
    name: z.string().optional().describe('Who to greet'),
  }),
  run: async ({ input }) => {
    const { handle } = await import('../../handler.js');
    return handle('admin show', input);
  },
});
