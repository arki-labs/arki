import type { Command, LazyCommand } from 'gunshi';
import { cli, define, lazy } from 'gunshi';

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

const helloDefinition = define({
  args: { name: { type: 'string', description: 'Who to greet' } },
});

const seedDefinition = define({
  args: {
    'max-batches': {
      type: 'positional',
      required: false,
      description: 'Stop after this many batches',
      parse: (text: string) => Number.parseInt(text, 10),
    },
    yes: { type: 'boolean', description: 'Skip the confirmation' },
  },
});

const benchDefinition = define({
  args: {
    label: { type: 'string', description: 'Name of this run', default: 'latest' },
    category: { type: 'enum', choices: CATEGORIES, multiple: true, description: 'Only run these categories' },
  },
});

function leaf(group: string, name: string, shape: 'hello' | 'seed' | 'bench'): LazyCommand {
  const path = `${group} ${name}`;
  const description = commandDescribe(group, name);
  if (shape === 'hello') {
    return lazy(() => async ctx => execute(path, ctx.values), { ...helloDefinition, name, description });
  }
  if (shape === 'seed') {
    return lazy(() => async ctx => execute(path, ctx.values), { ...seedDefinition, name, description });
  }
  return lazy(() => async ctx => execute(path, ctx.values), { ...benchDefinition, name, description });
}

function groupCommand(group: string): Command {
  const subCommands: Record<string, LazyCommand> = {};
  for (const { name, shape } of COMMANDS) subCommands[name] = leaf(group, name, shape);
  return define({ name: group, description: groupDescribe(group), subCommands });
}

const subCommands: Record<string, Command> = {};
for (const group of GROUPS) subCommands[group] = groupCommand(group);

await cli(process.argv.slice(2), define({ name: 'fifty', description: 'Fifty commands in ten groups' }), {
  name: 'fifty',
  version: VERSION,
  subCommands,
});
