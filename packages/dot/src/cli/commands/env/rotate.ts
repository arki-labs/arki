/**
 * `dot env rotate`: a new keypair for one environment. Every `.env.<env>` file in the repository is
 * re-encrypted together (they share a key name), then the new private key replaces the old one.
 */
import path from 'node:path';

import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { rotateEnvFiles } from '@arki/env/node';

import { envTargetInput, filesNamed, relative, resolveTarget } from '../../env-files.js';
import { EnvNoChange } from '../../env-failures.js';

export default defineCommand({
  describe: 'Re-encrypt every .env.<env> file in the repository to a new keypair',
  input: z.object({ env: envTargetInput.env, cwd: envTargetInput.cwd }),
  effects: 'write',
  examples: ['dot env rotate --env production'],
  run({ input }) {
    const target = resolveTarget(input);
    const name = path.basename(target.file);
    const files = filesNamed(target.root, name);
    if (files.length === 0) return EnvNoChange({ file: name, reason: `no ${name} file in the repository` });
    const result = rotateEnvFiles(files, { root: target.root });
    return {
      privateKeyName: result.privateKeyName,
      files: result.files.map(file => ({ file: relative(target.root, file.file), values: file.values })),
      keysFile: relative(target.root, result.keysFile),
      next: [
        `Replace ${result.privateKeyName} wherever it is set (Coolify runtime variable, CI secret).`,
        `Back up the new key: dot env keys push --env ${target.environment} --vault <vault> --force`,
      ],
    };
  },
  render(data, ui) {
    for (const file of data.files) ui.out(`  ${file.file}: ${String(file.values)} value(s) re-encrypted`);
    ui.out(`New ${data.privateKeyName} written to ${data.keysFile}.`);
    for (const step of data.next) ui.out(`Next: ${step}`);
  },
});
