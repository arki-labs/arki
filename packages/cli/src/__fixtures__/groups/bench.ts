import { z } from 'zod';

import { defineCommand } from '../../command.js';
import { group } from '../../tree.js';
import { CATEGORIES } from '../shapes.js';
import { imported } from '../tree.js';

imported('bench');

export default group('Run benchmarks', {
  run: defineCommand({
    describe: 'Run the bench',
    input: z.object({
      label: z.string().default('latest').describe('Name of this run'),
      category: z.array(z.enum(CATEGORIES)).optional().describe('Only run these categories'),
    }),
    examples: ['fixture bench run --label nightly --category refusal'],
    aliases: ['go'],
    run: ({ input }) => ({ label: input.label, categories: input.category ?? [] }),
  }),
});
