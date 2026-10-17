/**
 * The three input shapes the spike must parse: `hello` (one optional
 * string), `seed` (`seed-embeddings.ts`: an optional integer positional and
 * `--yes`), `bench` (`run-everseekbench.ts`: `--label` with a default and a
 * repeated enum `--category`).
 */
import { z } from 'zod';

export const CATEGORIES = ['reference-fidelity', 'refusal', 'routing', 'historical', 'pastoral', 'fairness'] as const;

export const helloInput = z.object({
  name: z.string().optional().describe('Who to greet'),
});

export const seedInput = z.object({
  maxBatches: z.int().min(1).optional().describe('Stop after this many batches'),
  yes: z.boolean().default(false).describe('Skip the confirmation'),
});
export const seedArgs = ['maxBatches'] as const;

export const benchInput = z.object({
  label: z.string().default('latest').describe('Name of this run'),
  category: z.array(z.enum(CATEGORIES)).optional().describe('Only run these categories'),
});
