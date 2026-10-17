import { Cli, z } from 'incur';

import { CATEGORIES, commandDescribe, COMMANDS, groupDescribe, GROUPS, VERSION } from '../tree-data.js';

async function execute(path: string, input: unknown): Promise<void> {
  if (path === 'bench run') {
    const { heavyHandle } = await import('../heavy.js');
    process.stdout.write(JSON.stringify(heavyHandle(input)) + '\n');
    return;
  }
  const { handle } = await import('../handler.js');
  process.stdout.write(JSON.stringify(handle(path, input)) + '\n');
}

function buildGroup(groupName: string) {
  const group = Cli.create(groupName, { description: groupDescribe(groupName) });
  for (const { name, shape } of COMMANDS) {
    const path = `${groupName} ${name}`;
    const description = commandDescribe(groupName, name);
    if (shape === 'hello') {
      group.command(name, {
        description,
        options: z.object({ name: z.string().optional().describe('Who to greet') }),
        async run(context) {
          await execute(path, context.options);
        },
      });
      continue;
    }
    if (shape === 'seed') {
      group.command(name, {
        description,
        args: z.object({ maxBatches: z.coerce.number().int().optional().describe('Stop after this many batches') }),
        options: z.object({ yes: z.boolean().default(false).describe('Skip the confirmation') }),
        async run(context) {
          await execute(path, { ...context.args, ...context.options });
        },
      });
      continue;
    }
    group.command(name, {
      description,
      options: z.object({
        label: z.string().default('latest').describe('Name of this run'),
        category: z.array(z.enum(CATEGORIES)).optional().describe('Only run these categories'),
      }),
      async run(context) {
        await execute(path, context.options);
      },
    });
  }
  return group;
}

const root = Cli.create('fifty', { description: 'Fifty commands in ten groups', version: VERSION });

for (const groupName of GROUPS) root.command(buildGroup(groupName));

await root.serve(process.argv.slice(2));
