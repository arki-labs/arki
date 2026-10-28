import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { attempt } from '@arki/failure';

import { FileReadFailed, FileWriteFailed } from './errors.js';
import { nodeOperation } from './operation-telemetry.js';

/** Foreign filesystem errors stay private; public outcomes identify only the file. */
export function readEnvText(file: string) {
  return nodeOperation('file.read', () =>
    attempt(
      () => readFileSync(file, 'utf8'),
      error => FileReadFailed({ file }, { cause: error }),
    ),
  );
}

/** Each replacement is atomic; owner-only new files and key stores never follow a planted temp symlink. */
export function writeEnvText(file: string, text: string, privateFile = false) {
  return nodeOperation('file.write', () => {
    let temp: string | undefined;
    try {
      const mode = privateFile ? 0o600 : existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
      temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
      writeFileSync(temp, text, { flag: 'wx', mode });
      renameSync(temp, file);
      return;
    } catch (error) {
      if (temp !== undefined) {
        try {
          unlinkSync(temp);
        } catch {
          /* The failed write may not have created a file. */
        }
      }
      return FileWriteFailed({ file }, { cause: error });
    }
  });
}
