// Fresh-process startup of a 50-command CLI: @arki/cli against a parseArgs-only
// program (no library, hand-written help) and six CLI libraries, each building the
// same tree from `fixtures/tree-data.ts`. Run: `bun run bench` (it compiles the
// fixtures to `.cache/bench` first). Numbers are only publishable from an idle
// machine (1-minute load under half the cores).
//
// Each case spawns one process and times it to exit; the contract is the same
// stdout for every row of a scenario's help, checked before timing by `expectOk`.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineSuite, metric } from '@arki/bench';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'bench', 'bench', 'fixtures');

const TARGETS = {
  arki: { label: '@arki/cli', file: 'fifty.js', package: undefined },
  parseArgs: { label: 'parseArgs-only', file: 'baseline.js', package: undefined },
  commander: { label: 'commander', file: 'competitors/commander.js', package: 'commander' },
  citty: { label: 'citty', file: 'competitors/citty.js', package: 'citty' },
  optique: { label: '@optique/core', file: 'competitors/optique.js', package: '@optique/core' },
  stricli: { label: '@stricli/core', file: 'competitors/stricli.js', package: '@stricli/core' },
  gunshi: { label: 'gunshi', file: 'competitors/gunshi.js', package: 'gunshi' },
  incur: { label: 'incur', file: 'competitors/incur.js', package: 'incur' },
} as const;

const SCENARIOS = [
  { id: 'help', title: '--help', args: ['--help'] },
  { id: 'version', title: '--version', args: ['--version'] },
  { id: 'command-help', title: 'bench run --help (imports one branch)', args: ['bench', 'run', '--help'] },
] as const;

/**
 * The binaries the rows spawn: the runtime running this suite for its own
 * rows (`arki-bench --node <path>` picks the Node), the other one from PATH.
 */
const underBun = process.versions['bun'] !== undefined;
const RUNTIMES = [
  { id: 'node', binary: underBun ? 'node' : process.execPath },
  { id: 'bun', binary: underBun ? process.execPath : 'bun' },
] as const;

/** Spawn once and return the wall time in ms. A non-zero exit or empty stdout fails the run. */
function spawnMs(binary: string, file: string, args: readonly string[]): number {
  const start = performance.now();
  const result = spawnSync(binary, [path.join(FIXTURES, file), ...args], { encoding: 'utf8' });
  const elapsed = performance.now() - start;
  if (result.status !== 0 || result.stdout.length === 0) {
    throw new Error(`${binary} ${file} ${args.join(' ')} exited ${String(result.status)}: ${result.stderr}`);
  }
  return elapsed;
}

export default defineSuite({
  id: '@arki/cli',
  intro:
    'Fresh-process startup of a 50-command CLI (10 lazy groups of 5 commands). `@arki/cli` against a parseArgs-only program with hand-written help and six CLI libraries, each building the same tree. Each row spawns one process per sample and times it to exit.',
  notes: [
    'citty has no repeatable flag; commander, optique and incur have no lazy subcommands; competitors are single-file, the @arki/cli fixture is 1 + 10 + 50 modules.',
    '`bench run --help` imports that command module, and with it Zod: help reads the flags from the input schema.',
  ],
  groups: RUNTIMES.flatMap(runtime =>
    SCENARIOS.map(scenario =>
      metric({
        id: `${runtime.id}-${scenario.id}`,
        title: `${runtime.id}: ${scenario.title}`,
        unit: 'ms',
        deterministic: false,
        baseline: 'arki',
        cases: Object.fromEntries(
          Object.entries(TARGETS).map(([key, target]) => [
            key,
            {
              label: target.label,
              ...(target.package === undefined ? {} : { package: target.package }),
              collect: () => spawnMs(runtime.binary, target.file, scenario.args),
            },
          ]),
        ),
      }),
    ),
  ),
});
