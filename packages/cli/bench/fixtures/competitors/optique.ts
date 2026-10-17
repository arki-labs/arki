// Uses only @optique/core: its `runParser` already wires --help and --version, so @optique/run is not needed.
import {
  argument,
  choice,
  command,
  flag,
  integer,
  map,
  message,
  multiple,
  object,
  option,
  optional,
  or,
  runParser,
  string,
  text,
  withDefault,
} from '@optique/core';

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

function leafOptions(summary: string) {
  return { brief: [text(summary)], description: [text(summary)] };
}

function helloLeaf(group: string, name: string) {
  const path = `${group} ${name}`;
  const { brief, description } = leafOptions(commandDescribe(group, name));
  const input = object({
    name: optional(option('--name', string({ metavar: 'STRING' }), { description: message`Who to greet` })),
  });
  return command(
    name,
    map(input, value => ({ path, input: value })),
    { brief, description },
  );
}

function seedLeaf(group: string, name: string) {
  const path = `${group} ${name}`;
  const { brief, description } = leafOptions(commandDescribe(group, name));
  const input = object({
    maxBatches: optional(
      argument(integer({ metavar: 'MAX-BATCHES' }), { description: message`Stop after this many batches` }),
    ),
    yes: withDefault(flag('--yes', { description: message`Skip the confirmation` }), false),
  });
  return command(
    name,
    map(input, value => ({ path, input: value })),
    { brief, description },
  );
}

function benchLeaf(group: string, name: string) {
  const path = `${group} ${name}`;
  const { brief, description } = leafOptions(commandDescribe(group, name));
  const input = object({
    label: withDefault(
      option('--label', string({ metavar: 'STRING' }), { description: message`Name of this run` }),
      'latest',
    ),
    category: multiple(option('--category', choice(CATEGORIES), { description: message`Only run these categories` })),
  });
  return command(
    name,
    map(input, value => ({ path, input: value })),
    { brief, description },
  );
}

function groupParser(group: string) {
  const summary = groupDescribe(group);
  const leaves = COMMANDS.map(({ name, shape }) =>
    shape === 'hello' ? helloLeaf(group, name) : shape === 'seed' ? seedLeaf(group, name) : benchLeaf(group, name),
  );
  return command(group, or(...leaves), { ...leafOptions(summary) });
}

const program = or(...GROUPS.map(group => groupParser(group)));

const parsed = runParser(program, 'fifty', process.argv.slice(2), {
  help: { option: true, onShow: () => null },
  version: { value: VERSION, option: true, onShow: () => null },
  onError: exitCode => {
    process.exitCode = exitCode;
    return null;
  },
});

if (parsed !== null) await execute(parsed.path, parsed.input);
