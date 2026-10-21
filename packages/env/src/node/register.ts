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
import { formatEnvFilesErrors, loadEnvFiles } from './load.js';

const report = loadEnvFiles();
if (report.errors.length > 0) throw new Error(formatEnvFilesErrors(report));
