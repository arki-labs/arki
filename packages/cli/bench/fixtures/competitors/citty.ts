import type { SubCommandsDef } from 'citty';
import { defineCommand, runMain } from 'citty';

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

function leaf(group: string, name: string, shape: 'hello' | 'seed' | 'bench') {
  const path = `${group} ${name}`;
  const meta = { name, description: commandDescribe(group, name) };
  if (shape === 'hello') {
    return defineCommand({
      meta,
      args: { name: { type: 'string', description: 'Who to greet' } },
      async run({ args }) {
        await execute(path, { name: args.name });
      },
    });
  }
  if (shape === 'seed') {
    return defineCommand({
      meta,
      args: {
        'max-batches': { type: 'positional', required: false, description: 'Stop after this many batches' },
        yes: { type: 'boolean', description: 'Skip the confirmation' },
      },
      async run({ args }) {
        const raw = args['max-batches'];
        await execute(path, { maxBatches: raw === undefined ? undefined : Number.parseInt(raw, 10), yes: args.yes });
      },
    });
  }
  return defineCommand({
    meta,
    args: {
      label: { type: 'string', description: 'Name of this run', default: 'latest' },
      // citty has no repeatable flag type: one choice per run is the closest.
      category: { type: 'enum', options: [...CATEGORIES], description: 'Only run these categories' },
    },
    async run({ args }) {
      await execute(path, { label: args.label, category: args.category });
    },
  });
}

function groupCommand(group: string) {
  const subCommands: SubCommandsDef = {};
  for (const { name, shape } of COMMANDS) subCommands[name] = () => leaf(group, name, shape);
  return defineCommand({ meta: { name: group, description: groupDescribe(group) }, subCommands });
}

const groups: SubCommandsDef = {};
for (const group of GROUPS) groups[group] = () => groupCommand(group);

const main = defineCommand({
  meta: { name: 'fifty', version: VERSION, description: 'Fifty commands in ten groups' },
  subCommands: groups,
});

await runMain(main, { rawArgs: process.argv.slice(2) });
