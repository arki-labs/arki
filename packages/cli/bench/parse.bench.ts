// In-process parse + validate of the `seed` shape (an optional integer
// positional and `--yes`): @arki/cli's parser against node:util parseArgs with
// hand coercion and commander. Every case returns the same validated object,
// checked before timing.

import { parseArgs } from 'node:util';
import { Command } from 'commander';

import { compare, defineSuite } from '@arki/bench';

import { seedArgs, seedInput } from '../src/__fixtures__/shapes.js';
import { flagsOf } from '../src/flags.js';
import { parse } from '../src/parse.js';

const ARGV: readonly (readonly string[])[] = [['5', '--yes'], ['--yes'], ['12'], ['--max-batches=3']];
const specs = flagsOf(seedInput, seedArgs);

function show(value: { readonly maxBatches?: number | undefined; readonly yes: boolean }): string {
  return JSON.stringify({ maxBatches: value.maxBatches ?? null, yes: value.yes });
}

export default defineSuite({
  id: '@arki/cli/parse',
  intro:
    'In-process parse and validate of one command line for the `seed` shape (`[max-batches]` integer, `--yes`). Each case turns argv into the Zod-validated input.',
  groups: [
    compare({
      id: 'seed',
      title: 'Parse and validate the seed shape',
      contract: { id: 'cli-parse-seed/v1', description: 'argv to the validated { maxBatches, yes } object' },
      inputs: ARGV,
      expected: argv => {
        const { values, positionals } = parseArgs({
          args: [...argv],
          options: { 'max-batches': { type: 'string' }, yes: { type: 'boolean' } },
          allowPositionals: true,
        });
        const raw = values['max-batches'] ?? positionals[0];
        return show({ maxBatches: raw === undefined ? undefined : Number(raw), yes: values.yes === true });
      },
      baseline: 'arki',
      cases: build => ({
        arki: build({
          label: '@arki/cli',
          run: argv => {
            const parsed = parse(specs, argv);
            if (!parsed.ok) throw new Error(parsed.issues.map(issue => issue.message).join('; '));
            return show(seedInput.parse(parsed.value));
          },
        }),
        parseArgs: build({
          label: 'parseArgs-only',
          run: argv => {
            const { values, positionals } = parseArgs({
              args: [...argv],
              options: { 'max-batches': { type: 'string' }, yes: { type: 'boolean' } },
              allowPositionals: true,
            });
            const raw = values['max-batches'] ?? positionals[0];
            return show(seedInput.parse({ maxBatches: raw === undefined ? undefined : Number(raw), yes: values.yes }));
          },
        }),
        commander: build({
          label: 'commander',
          package: 'commander',
          run: argv => {
            const program = new Command('seed')
              .exitOverride()
              .argument('[max-batches]')
              .option('--max-batches <n>')
              .option('--yes');
            program.parse([...argv], { from: 'user' });
            const options = program.opts<{ maxBatches?: string; yes?: boolean }>();
            const raw = options.maxBatches ?? program.args[0];
            return show(seedInput.parse({ maxBatches: raw === undefined ? undefined : Number(raw), yes: options.yes }));
          },
        }),
      }),
    }),
  ],
});
