/** `dot env ls`: every key, where it comes from, and how it is stored. Never a value. */
import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { loadEnvFiles } from '@arki/env/node';

import { envTargetInput, loadDescription, relative, resolveTarget } from '../../env-files.js';

export default defineCommand({
  describe: 'List keys with source, storage and shadowing; never values',
  input: z.object({ schema: z.string().optional().describe('Env module to read declared keys from (default: src/env.ts)'), env: envTargetInput.env, cwd: envTargetInput.cwd }),
  effects: 'read',
  examples: ['dot env ls', 'dot env ls --env production --json'],
  async run({ input, ui }) {
    const target = resolveTarget(input);
    const report = loadEnvFiles({ cwd: target.cwd, root: target.root, environment: target.environment, env: { ...process.env }, write: false });
    const schema = await loadDescription(target.cwd, input.schema);
    if (schema.problem !== undefined) ui.warn(schema.problem);
    const declared = new Map((schema.description?.keys ?? []).map(key => [key.key, key]));
    const shadowed = new Set(report.shadowed.map(entry => entry.key));
    const keys = report.values.map(value => ({
      key: value.key,
      kind: value.kind,
      file: relative(target.root, value.file),
      line: value.line,
      secret: value.kind !== 'plain' || declared.get(value.key)?.secret === true,
      source: shadowed.has(value.key) ? 'environment' : 'file',
    }));
    const inFiles = new Set(keys.map(key => key.key));
    for (const key of declared.values()) {
      if (inFiles.has(key.key)) continue;
      const set = (process.env[key.key] ?? '') !== '';
      keys.push({ key: key.key, kind: 'plain', file: '', line: 0, secret: key.secret, source: set ? 'environment' : 'missing' });
    }
    return { environment: target.environment, files: report.files.map(file => relative(target.root, file)), keys };
  },
  render(data, ui) {
    ui.out(`${data.environment}: ${data.files.join(', ') || '(no env files)'}`);
    for (const key of data.keys) {
      const where = key.file === '' ? '' : `${key.file}:${String(key.line)}`;
      ui.out(`  ${key.key.padEnd(32)} ${key.source.padEnd(11)} ${(key.secret ? `${key.kind} secret` : key.kind).padEnd(17)} ${where}`);
    }
  },
});
