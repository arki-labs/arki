/** `dot env keys push`: store an environment's private key in 1Password. The key goes through stdin. */
import path from 'node:path';
import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { findPrivateKey } from '@arki/env/node';
import { isFailure } from '@arki/failure';

import { EnvLoadFailed, EnvVaultFailed } from '../../env-failures.js';
import { envTargetInput, resolveTarget } from '../../env-files.js';
import { readVaultItem, vaultItemTitle, writeVaultItem } from './keys-shared.js';

export default defineCommand({
  describe: 'Store the private key of an environment in a 1Password vault',
  input: z.object({
    vault: z.string().min(1).describe('1Password vault name'),
    force: z.boolean().default(false).describe('Replace an existing item'),
    env: envTargetInput.env,
    cwd: envTargetInput.cwd,
  }),
  effects: 'write',
  examples: ['dot env keys push --vault Engineering', 'dot env keys push --env production --vault Ops --force'],
  run({ input }) {
    const target = resolveTarget(input);
    const found = findPrivateKey(path.join(target.root, `.env.${target.environment}`), {
      root: target.root,
      env: process.env,
    });
    if (isFailure(found)) return found;
    const privateKey = found?.keys[0];
    if (found === undefined || privateKey === undefined) {
      return EnvLoadFailed({
        errors: [
          {
            code: 'ARKI_ENV_FILES_E001',
            message: `no ${target.environment} private key to push`,
            file: `.env.${target.environment}`,
          },
        ],
      });
    }
    const title = vaultItemTitle(target.root, target.environment);
    const existing = readVaultItem(input.vault, title);
    if (isFailure(existing)) return existing;
    const matches = existing?.fields.find(field => field.id === 'password')?.value === privateKey;
    if (existing !== undefined && !matches && !input.force)
      return EnvVaultFailed({ reason: 'The backup already exists with another key; pass --force to update it' });
    if (!matches) {
      const written = writeVaultItem(input.vault, title, privateKey, existing);
      if (isFailure(written)) return written;
    }
    return { vault: input.vault, item: title, replaced: existing !== undefined };
  },
});
