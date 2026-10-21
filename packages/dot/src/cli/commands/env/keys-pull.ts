/** `dot env keys pull`: restore an environment's private key from 1Password into `<root>/.env.keys`. */
import path from 'node:path';

import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { KEYS_FILE, keyNamesFor, publicKeyOf, writePrivateKey } from '@arki/env/node';

import { envTargetInput, relative, resolveTarget } from '../../env-files.js';
import { EnvVaultFailed } from '../../env-failures.js';
import { op, vaultItemTitle } from './keys-shared.js';

export default defineCommand({
  describe: 'Restore the private key of an environment from a 1Password vault into .env.keys',
  input: z.object({ vault: z.string().min(1).describe('1Password vault name'), env: envTargetInput.env, cwd: envTargetInput.cwd }),
  effects: 'idempotent',
  examples: ['dot env keys pull --vault Engineering'],
  run({ input }) {
    const target = resolveTarget(input);
    const title = vaultItemTitle(target.root, target.environment);
    const read = op(['read', '--no-newline', `op://${input.vault}/${title}/password`]);
    if (!read.ok) return EnvVaultFailed({ reason: read.reason });
    try {
      publicKeyOf(read.out);
    } catch {
      return EnvVaultFailed({ reason: `"${title}" does not hold a valid private key` });
    }
    const keysFile = path.join(target.root, KEYS_FILE);
    writePrivateKey(keysFile, keyNamesFor(`.env.${target.environment}`).privateKey, read.out, `.env.${target.environment}`);
    return { vault: input.vault, item: title, keysFile: relative(target.root, keysFile) };
  },
});
