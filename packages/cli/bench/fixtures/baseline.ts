/**
 * The floor: `node:util` `parseArgs` and help text written by hand, no
 * library and no lazy tree. The spike's `--help` median must stay within
 * 5 ms of this.
 */
import { parseArgs } from 'node:util';

import { CATEGORIES, commandDescribe, COMMANDS, groupDescribe, GROUPS, VERSION } from './tree-data.js';

const ROOT_HELP = `A 50-command fixture\n\nUsage: fifty <command>\n\nCommands:\n${GROUPS.map(group => `  ${group.padEnd(9)}${groupDescribe(group)}`).join('\n')}\n`;
const BENCH_RUN_HELP = `${commandDescribe('bench', 'run')}\n\nUsage: fifty bench run [options]\n\nOptions:\n  --label <string>  Name of this run\n  --category <${CATEGORIES.join('|')}>  Only run these categories (repeatable)\n`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: 'boolean' },
    version: { type: 'boolean' },
    label: { type: 'string' },
    category: { type: 'string', multiple: true },
    name: { type: 'string' },
    yes: { type: 'boolean' },
  },
  strict: false,
  allowPositionals: true,
});

const [group, command] = positionals;
if (values['version'] === true) {
  process.stdout.write(`${VERSION}\n`);
} else if (values['help'] === true && group === 'bench' && command === 'run') {
  process.stdout.write(BENCH_RUN_HELP);
} else if (values['help'] === true || group === undefined) {
  process.stdout.write(ROOT_HELP);
} else if (
  group !== undefined &&
  new Set<string>(GROUPS).has(group) &&
  COMMANDS.some(entry => entry.name === command)
) {
  const { handle } = await import('./handler.js');
  process.stdout.write(`${JSON.stringify(handle(`${group} ${command ?? ''}`, values))}\n`);
} else {
  process.exitCode = 2;
}
