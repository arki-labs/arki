/**
 * `dot env encrypt`: encrypt plaintext values in place, or import a plaintext file (`--from`):
 * secret-looking and `secret()` keys are encrypted, the rest stay plain, and both lists are returned
 * for review.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { encryptEnvFile, envValues, isKeyName, parseEnv, publicKeyIn, setEnvFileValue } from '@arki/env/node';
import { isFailure } from '@arki/failure';

import { EnvNoChange, EnvNoHeader } from '../../env-failures.js';
import { envTargetInput, loadDescription, relative, resolveTarget } from '../../env-files.js';

/** Names that usually hold a secret. A URL may carry a password (`postgres://user:pass@...`). */
const SECRET_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|KEY|DSN|CREDENTIAL|PRIVATE|AUTH|URL$|URI$/i;

export default defineCommand({
  describe: 'Encrypt plaintext values in place, or import a plaintext .env file with --from',
  input: z.object({
    key: z.array(z.string()).optional().describe('Only these keys (repeat --key)'),
    from: z
      .string()
      .optional()
      .describe('Plaintext file to import: secret-looking keys are encrypted, the rest stay plain'),
    all: z.boolean().default(false).describe('With --from: encrypt every value, not only secret-looking ones'),
    schema: z.string().optional().describe('Env module to read secret() keys from (default: src/env.ts)'),
    ...envTargetInput,
  }),
  effects: 'write',
  examples: ['dot env encrypt', 'dot env encrypt --key STRIPE_SECRET_KEY', 'dot env encrypt --from .env --all'],
  async run({ input, ui }) {
    const target = resolveTarget(input);
    const file = relative(target.root, target.file);
    const publicKey = publicKeyIn(target.file);
    if (isFailure(publicKey)) return publicKey;
    if (publicKey === undefined) return EnvNoHeader({ file });
    if (input.from === undefined) {
      const encrypted = encryptEnvFile(target.file, input.key);
      if (isFailure(encrypted)) return encrypted;
      if (encrypted.length === 0) return EnvNoChange({ file, reason: 'no plaintext value to encrypt' });
      return { file, encrypted, plain: [] };
    }
    const source = path.resolve(target.cwd, input.from);
    if (!existsSync(source)) return EnvNoChange({ file, reason: `${input.from} does not exist` });
    const schema = await loadDescription(target.cwd, input.schema);
    if (schema.problem !== undefined) ui.warn(schema.problem);
    const secretKeys = new Set((schema.description?.keys ?? []).filter(key => key.secret).map(key => key.key));
    const encrypted: string[] = [];
    const plain: string[] = [];
    for (const [key, entry] of envValues(parseEnv(readFileSync(source, 'utf8')))) {
      if (isKeyName(key) || (input.key !== undefined && !input.key.includes(key))) continue;
      const secret = input.all || secretKeys.has(key) || SECRET_NAME.test(key);
      const changed = setEnvFileValue(target.file, key, entry.value, { plain: !secret });
      if (isFailure(changed)) return changed;
      (secret ? encrypted : plain).push(key);
    }
    if (encrypted.length + plain.length === 0) return EnvNoChange({ file, reason: `${input.from} has no values` });
    return { file, encrypted, plain };
  },
  render(data, ui) {
    ui.out(`${data.file}: ${String(data.encrypted.length)} encrypted, ${String(data.plain.length)} plain`);
    if (data.plain.length > 0) ui.out(`  plain (review): ${data.plain.join(', ')}`);
  },
});
