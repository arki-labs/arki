/**
 * Side-effect entry: load the env files into `process.env` as this module is imported. Import it
 * first in a process entry, before any module that reads the environment:
 *
 * ```ts
 * import '@arki/env/node/register';
 * ```
 *
 * Fails the import with every problem listed (names only, never values).
 */
import { isFailure, orThrow } from '@arki/failure';

import { EnvFilesFailed } from './errors.js';
import { formatEnvFilesErrors, loadEnvFiles } from './load.js';

const report = loadEnvFiles();
if (EnvFilesFailed.is(report)) throw new Error(formatEnvFilesErrors(report), { cause: report });
if (isFailure(report)) orThrow(report);
