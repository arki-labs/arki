/** `dot env keys pull`: restore an environment's private key from 1Password into `<root>/.env.keys`. */
import path from 'node:path';
import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { keyNamesFor, KEYS_FILE, parsePrivateKey, writePrivateKey } from '@arki/env/node';
import { isFailure } from '@arki/failure';

import { envTargetInput, relative, resolveTarget } from '../../env-files.js';
import { op, vaultItemTitle } from './keys-shared.js';

export default defineCommand({
  describe: 'Restore the private key of an environment from a 1Password vault into .env.keys',
  input: z.object({
    vault: z.string().min(1).describe('1Password vault name'),
    env: envTargetInput.env,
    cwd: envTargetInput.cwd,
  }),
  effects: 'idempotent',
  examples: ['dot env keys pull --vault Engineering'],
  run({ input }) {
    const target = resolveTarget(input);
    const title = vaultItemTitle(target.root, target.environment);
    const read = op(['read', '--no-newline', `op://${input.vault}/${title}/password`]);
    if (isFailure(read)) return read;
    const privateKey = parsePrivateKey(read);
    if (isFailure(privateKey)) return privateKey;
    const keysFile = path.join(target.root, KEYS_FILE);
    const written = writePrivateKey(
      keysFile,
      keyNamesFor(`.env.${target.environment}`).privateKey,
      privateKey,
      `.env.${target.environment}`,
    );
    if (isFailure(written)) return written;
    return { vault: input.vault, item: title, keysFile: relative(target.root, keysFile) };
  },
});
