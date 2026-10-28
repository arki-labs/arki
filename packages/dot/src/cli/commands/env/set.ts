/** `dot env set KEY [VALUE]`: write one value, encrypted unless `--plain`. Needs only the public key. */
import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { publicKeyIn, setEnvFileValue } from '@arki/env/node';
import { isFailure } from '@arki/failure';

import { EnvNoChange, EnvNoHeader, EnvPlainSecret, EnvValueMissing } from '../../env-failures.js';
import { envTargetInput, loadDescription, readStdin, relative, resolveTarget } from '../../env-files.js';

export default defineCommand({
  describe: 'Set a value, encrypted to the file public key (agents can write without reading)',
  input: z.object({
    key: z
      .string()
      .regex(/^[_a-z]\w*$/i)
      .describe('Variable name'),
    value: z.string().optional().describe('The value (prefer --stdin: an argument stays in shell history)'),
    stdin: z.boolean().default(false).describe('Read the value from stdin'),
    plain: z.boolean().default(false).describe('Store as plaintext (refused for secret() keys)'),
    schema: z.string().optional().describe('Env module to read secret() keys from (default: src/env.ts)'),
    ...envTargetInput,
  }),
  args: ['key', 'value'],
  effects: 'idempotent',
  examples: ['printf %s "$STRIPE_KEY" | dot env set STRIPE_SECRET_KEY --stdin', 'dot env set PORT 3000 --plain'],
  async run({ input, ui }) {
    const target = resolveTarget(input);
    const file = relative(target.root, target.file);
    if ((input.value === undefined) === !input.stdin) return EnvValueMissing({ key: input.key });
    const value = input.value ?? (await readStdin());
    if (input.plain) {
      const schema = await loadDescription(target.cwd, input.schema);
      if (schema.problem !== undefined) ui.warn(schema.problem);
      if (schema.description?.keys.some(key => key.key === input.key && key.secret) === true)
        return EnvPlainSecret({ key: input.key });
    }
    if (!input.plain) {
      const publicKey = publicKeyIn(target.file);
      if (isFailure(publicKey)) return publicKey;
      if (publicKey === undefined) return EnvNoHeader({ file });
    }
    const changed = setEnvFileValue(target.file, input.key, value, { plain: input.plain });
    if (isFailure(changed)) return changed;
    if (!changed) return EnvNoChange({ file, reason: `${input.key} already holds this value` });
    const shell = process.env[input.key];
    const shadowedByShell = shell !== undefined && shell !== '' && shell !== value;
    if (shadowedByShell) ui.warn(`${input.key} is also set in this shell; it wins over the file until you unset it`);
    return { file, key: input.key, stored: input.plain ? 'plain' : 'encrypted', shadowedByShell };
  },
});
