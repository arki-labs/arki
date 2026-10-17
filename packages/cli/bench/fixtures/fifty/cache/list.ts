import { z } from 'zod';

import { defineCommand } from '../../../../src/index.js';
import { CATEGORIES, commandDescribe } from '../../tree-data.js';

export default defineCommand({
  describe: commandDescribe('cache', 'list'),
  input: z.object({
    label: z.string().default('latest').describe('Name of this run'),
    category: z.array(z.enum(CATEGORIES)).optional().describe('Only run these categories'),
  }),
  run: async ({ input }) => {
    const { handle } = await import('../../handler.js');
    return handle('cache list', input);
  },
});
