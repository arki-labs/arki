/** `dot env decrypt`: decrypt values in place. Refused on a tracked file unless `--force`. */
import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { decryptEnvFile, findPrivateKey } from '@arki/env/node';
import { isFailure } from '@arki/failure';

import { EnvDecryptTracked, EnvLoadFailed, EnvNoChange } from '../../env-failures.js';
import { envTargetInput, relative, resolveTarget, trackedFiles } from '../../env-files.js';

export default defineCommand({
  describe: 'Decrypt values in place (refused on tracked files without --force)',
  input: z.object({
    key: z.array(z.string()).optional().describe('Only these keys (repeat --key)'),
    force: z.boolean().default(false).describe('Decrypt a file git tracks'),
    ...envTargetInput,
  }),
  effects: 'write',
  examples: ['dot env decrypt --file .env.local', 'dot env decrypt --key DB_URL --force'],
  run({ input }) {
    const target = resolveTarget(input);
    const file = relative(target.root, target.file);
    if (!input.force) {
      const tracked = trackedFiles(target.root, [target.file]);
      // Unknown counts as tracked: decrypting in place must fail closed.
      if (!tracked.ok || tracked.value.has(target.file)) return EnvDecryptTracked({ file });
    }
    const found = findPrivateKey(target.file, { root: target.root, env: process.env });
    if (isFailure(found)) return found;
    if (found === undefined)
      return EnvLoadFailed({ errors: [{ code: 'ARKI_ENV_FILES_E001', message: `no private key for ${file}`, file }] });
    const decrypted = decryptEnvFile(target.file, found.keys, input.key);
    if (isFailure(decrypted)) return decrypted;
    if (decrypted.length === 0) return EnvNoChange({ file, reason: 'no encrypted value to decrypt' });
    return { file, decrypted };
  },
});
