import type { Command } from '@stricli/core';
import { buildApplication, buildCommand, buildRouteMap, numberParser, run } from '@stricli/core';

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

type HelloFlags = {
  readonly name?: string;
};
type SeedFlags = {
  readonly yes?: boolean;
};
type BenchFlags = {
  readonly label: string;
  readonly category?: readonly (typeof CATEGORIES)[number][];
};

function leaf(group: string, name: string, shape: 'hello' | 'seed' | 'bench'): Command<ReturnType<typeof contextOf>> {
  const path = `${group} ${name}`;
  const docs = { brief: commandDescribe(group, name) };
  if (shape === 'hello') {
    return buildCommand({
      loader: async () =>
        async function hello(flags: HelloFlags): Promise<void> {
          await execute(path, flags);
        },
      parameters: { flags: { name: { kind: 'parsed', parse: String, brief: 'Who to greet', optional: true } } },
      docs,
    });
  }
  if (shape === 'seed') {
    return buildCommand({
      loader: async () =>
        async function seed(flags: SeedFlags, maxBatches?: number): Promise<void> {
          await execute(path, { maxBatches, ...flags });
        },
      parameters: {
        flags: { yes: { kind: 'boolean', brief: 'Skip the confirmation', optional: true } },
        positional: {
          kind: 'tuple',
          parameters: [
            { brief: 'Stop after this many batches', parse: numberParser, placeholder: 'max-batches', optional: true },
          ],
        },
      },
      docs,
    });
  }
  return buildCommand({
    loader: async () =>
      async function bench(flags: BenchFlags): Promise<void> {
        await execute(path, flags);
      },
    parameters: {
      flags: {
        label: { kind: 'parsed', parse: String, brief: 'Name of this run', default: 'latest' },
        category: {
          kind: 'enum',
          values: CATEGORIES,
          variadic: true,
          brief: 'Only run these categories',
          optional: true,
        },
      },
    },
    docs,
  });
}

function contextOf() {
  return { process };
}

function groupRoutes(group: string) {
  const routes: Record<string, Command<ReturnType<typeof contextOf>>> = {};
  for (const { name, shape } of COMMANDS) routes[name] = leaf(group, name, shape);
  return buildRouteMap({ routes, docs: { brief: groupDescribe(group) } });
}

const groups = Object.fromEntries(GROUPS.map(group => [group, groupRoutes(group)]));

const app = buildApplication(buildRouteMap({ routes: groups, docs: { brief: 'Fifty commands in ten groups' } }), {
  name: 'fifty',
  versionInfo: { currentVersion: VERSION },
});

await run(app, process.argv.slice(2), contextOf());
