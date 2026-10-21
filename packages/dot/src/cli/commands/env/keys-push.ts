/** `dot env keys push`: store an environment's private key in 1Password. The key goes through stdin. */
import path from 'node:path';

import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { findPrivateKey } from '@arki/env/node';

import { envTargetInput, resolveTarget } from '../../env-files.js';
import { EnvLoadFailed, EnvVaultFailed } from '../../env-failures.js';
import { op, vaultItemTitle } from './keys-shared.js';

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
    const found = findPrivateKey(path.join(target.root, `.env.${target.environment}`), { root: target.root, env: process.env });
    const privateKey = found?.keys[0];
    if (found === undefined || privateKey === undefined) {
      return EnvLoadFailed({ errors: [{ code: 'ARKI_ENV_FILES_E001', message: `no ${target.environment} private key to push`, file: `.env.${target.environment}` }] });
    }
    const title = vaultItemTitle(target.root, target.environment);
    const exists = op(['item', 'get', title, `--vault=${input.vault}`, '--format=json']).ok;
    if (exists && !input.force) return EnvVaultFailed({ reason: `"${title}" already exists in ${input.vault}; pass --force to replace it` });
    if (exists) {
      const removed = op(['item', 'delete', title, `--vault=${input.vault}`]);
      if (!removed.ok) return EnvVaultFailed({ reason: removed.reason });
    }
    const item = {
      title,
      category: 'PASSWORD',
      fields: [{ id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', label: 'password', value: privateKey }],
    };
    const created = op(['item', 'create', `--vault=${input.vault}`, '--format=json', '-'], JSON.stringify(item));
    if (!created.ok) return EnvVaultFailed({ reason: created.reason });
    return { vault: input.vault, item: title, replaced: exists };
  },
});
