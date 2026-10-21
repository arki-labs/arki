/** `dot env explain KEY`: the whole precedence chain for one key. Never a value. */
import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { DEFAULT_RESOLVERS, findPrivateKey, isEncrypted, loadEnvFiles, parseEnv, referenceScheme } from '@arki/env/node';

import { envTargetInput, relative, resolveTarget } from '../../env-files.js';

export default defineCommand({
  describe: 'Show every file that sets a key, which one wins, and where its private key comes from',
  input: z.object({ key: z.string().describe('Variable name'), env: envTargetInput.env, cwd: envTargetInput.cwd }),
  args: ['key'],
  effects: 'read',
  examples: ['dot env explain DB_URL'],
  run({ input }) {
    const target = resolveTarget(input);
    const report = loadEnvFiles({ cwd: target.cwd, root: target.root, environment: target.environment, env: { ...process.env }, write: false });
    const definitions = report.files.flatMap(file =>
      parseEnv(readFileSync(file, 'utf8'))
        .entries.filter(entry => entry.key === input.key)
        .map(entry => ({
          file: relative(target.root, file),
          line: entry.start + 1,
          kind: isEncrypted(entry.value) ? 'encrypted' : referenceScheme(entry.value, DEFAULT_RESOLVERS) === undefined ? 'plain' : 'reference',
        })),
    );
    const winner = report.values.find(value => value.key === input.key);
    const shell = process.env[input.key] ?? '';
    const environment = shell === '' || isEncrypted(shell) ? 'unset' : report.shadowed.some(entry => entry.key === input.key) ? 'set, wins over the file' : 'set';
    const source = winner?.kind === 'encrypted' ? findPrivateKey(winner.file, { root: target.root, env: process.env })?.source : undefined;
    return {
      key: input.key,
      environment: target.environment,
      definitions,
      processEnv: environment,
      winner: winner === undefined ? null : { file: relative(target.root, winner.file), line: winner.line, kind: winner.kind },
      privateKey: source === undefined ? null : source.kind === 'env' ? `environment variable ${source.name}` : `${source.name} in ${relative(target.root, source.path)}`,
    };
  },
  render(data, ui) {
    if (data.definitions.length === 0) ui.out(`${data.key}: in no ${data.environment} env file`);
    for (const definition of data.definitions) ui.out(`  ${definition.file}:${String(definition.line)} (${definition.kind})`);
    ui.out(`process env: ${data.processEnv}`);
    if (data.winner !== null) ui.out(`file value used: ${data.winner.file}:${String(data.winner.line)}`);
    if (data.privateKey !== null) ui.out(`private key: ${data.privateKey}`);
  },
});
