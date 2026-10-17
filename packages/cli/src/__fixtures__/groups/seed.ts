import { z } from 'zod';

import { defineCommand } from '../../command.js';
import { NotReady } from '../failures.js';
import { seedArgs, seedInput } from '../shapes.js';
import { imported } from '../tree.js';

imported('seed');

export default defineCommand({
  describe: 'Seed embeddings',
  input: seedInput,
  args: seedArgs,
  output: z.object({ embedded: z.number() }),
  preview: ({ input }) => ({ embedded: 0 * (input.maxBatches ?? 1) }),
  run: ({ input }) =>
    input.maxBatches === 99 ? NotReady({ provider: 'local' }) : { embedded: (input.maxBatches ?? 1) * 100 },
});
