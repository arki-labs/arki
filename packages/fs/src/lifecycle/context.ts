/**
 * What the storage calls and the sweep share on every dialect: the log and
 * the one way to throw a coded fault.
 */
import { getLogger } from '@arki/log';

import type { FileErrorCode } from '../files/errors.js';
import { FileStorageError } from '../files/errors.js';

/** Lifecycle at DEBUG, store failures at WARN. Never URLs, credentials or bytes. */
export const filesLog = getLogger('arki:fs');

export function fail(code: FileErrorCode, message: string, cause?: unknown): never {
  throw new FileStorageError(code, message, cause === undefined ? undefined : { cause });
}
