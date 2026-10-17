/** `dot new <name>`: scaffold a DOT app from a bundled template. `--dry-run` plans and writes nothing. */
import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { isFailure } from '@arki/failure';

import { runNew, TEMPLATE_NAMES, validateAppName } from '../new.js';

export default defineCommand({
  describe: 'Scaffold a DOT app',
  input: z.object({
    name: z
      .string()
      .superRefine((name, ctx) => {
        const problem = validateAppName(name);
        if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
      })
      .describe('App name: becomes package.json#name and the default directory'),
    target: z.string().optional().describe('Directory to create the app in (default: <name>)'),
    template: z
      .enum(TEMPLATE_NAMES)
      .optional()
      .describe('stack (default): TanStack Start + oRPC + Postgres + journal; minimal: defineApp + env only'),
    pm: z.enum(['npm', 'pnpm', 'bun']).optional().describe('Package manager named in the README (default: bun)'),
    force: z.boolean().optional().describe('Overwrite existing files in the target directory'),
    cwd: z.string().optional().describe('Working directory the target resolves against (default: current)'),
  }),
  args: ['name'],
  effects: 'write',
  examples: ['dot new my-app', 'dot new my-app --template minimal --dry-run --json'],
  async preview({ input, ui }) {
    const result = await runNew({ ...input, dryRun: true });
    if (!isFailure(result)) {
      ui.info(`Would scaffold ${String(result.operations.length)} file(s) under ${result.app.target}:`);
    }
    return result;
  },
  async run({ input, ui }) {
    const result = await runNew(input);
    if (!isFailure(result)) {
      ui.info(`Scaffolded ${String(result.operations.length)} file(s) under ${result.app.target}.`);
    }
    return result;
  },
  render(data, ui) {
    for (const op of data.operations) ui.out(`  ${op.action.padEnd(9)} ${op.path}`);
    ui.out('Next steps:');
    for (const step of data.nextSteps) ui.out(`  ${step}`);
  },
});
