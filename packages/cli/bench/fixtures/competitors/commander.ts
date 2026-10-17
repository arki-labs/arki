import { Command, Option } from 'commander';

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

function parseCount(text: string): number {
  return Number.parseInt(text, 10);
}

const program = new Command('fifty').description('Fifty commands in ten groups').version(VERSION);

for (const group of GROUPS) {
  const groupCommand = program.command(group).description(groupDescribe(group));
  for (const { name, shape } of COMMANDS) {
    const command = groupCommand.command(name).description(commandDescribe(group, name));
    const path = `${group} ${name}`;
    if (shape === 'hello') {
      command.option('--name <string>', 'Who to greet').action(async options => {
        await execute(path, options);
      });
    } else if (shape === 'seed') {
      command
        .argument('[max-batches]', 'Stop after this many batches', parseCount)
        .option('--yes', 'Skip the confirmation')
        .action(async (maxBatches, options) => {
          await execute(path, { maxBatches, ...options });
        });
    } else {
      command
        .option('--label <string>', 'Name of this run', 'latest')
        .addOption(new Option('--category <choice...>', 'Only run these categories').choices(CATEGORIES))
        .action(async options => {
          await execute(path, options);
        });
    }
  }
}

await program.parseAsync(process.argv.slice(2), { from: 'user' });
