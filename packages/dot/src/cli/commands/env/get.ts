/** `dot env get KEY`: the shape of a value; the value itself only with `--reveal` on a terminal. */
import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { loadEnvFiles } from '@arki/env/node';
import { isFailure } from '@arki/failure';

import { EnvKeyNotFound, EnvLoadFailed, EnvRevealRefused } from '../../env-failures.js';
import { charClass, envTargetInput, relative, resolveTarget } from '../../env-files.js';
import { privateKeysOnly } from './shared.js';

export default defineCommand({
  describe: 'Show the length and character class of a value; --reveal prints it on a terminal',
  input: z.object({
    key: z.string().describe('Variable name'),
    reveal: z.boolean().default(false).describe('Print the value (terminal only)'),
    env: envTargetInput.env,
    cwd: envTargetInput.cwd,
  }),
  args: ['key'],
  effects: 'read',
  examples: ['dot env get STRIPE_SECRET_KEY', 'dot env get DB_URL --reveal'],
  run({ input }) {
    const target = resolveTarget(input);
    const report = loadEnvFiles({
      cwd: target.cwd,
      root: target.root,
      environment: target.environment,
      env: privateKeysOnly(),
      write: false,
    });
    if (isFailure(report)) return report;
    const entry = report.values.find(value => value.key === input.key);
    if (entry === undefined) return EnvKeyNotFound({ key: input.key, environment: target.environment });
    if (entry.value === undefined)
      return EnvLoadFailed({
        errors: report.errors
          .filter(error => error.key === input.key || error.file === entry.file)
          .map(error => ({ ...error, file: relative(target.root, error.file) })),
      });
    if (input.reveal && process.stdout.isTTY !== true) return EnvRevealRefused({ key: input.key });
    const shape = {
      key: entry.key,
      file: relative(target.root, entry.file),
      line: entry.line,
      kind: entry.kind,
      length: entry.value.length,
      charClass: charClass(entry.value),
    };
    return input.reveal ? { ...shape, value: entry.value } : shape;
  },
});
