/**
 * What the storage calls and the sweep share: the database, the adapter, the
 * table and the parsed config. Internal to `@arki/fs/pg`.
 */
import type { AnyRelations } from 'drizzle-orm';
import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { getLogger } from '@arki/log';

import type { FileErrorCode } from '../files/errors.js';
import type { SignedUploadAdapter } from '../storage/types.js';
import type { FilesTable } from './table.js';
import { FileStorageError } from '../files/errors.js';

/**
 * The root Drizzle database (`PgAsyncDatabase`, as in `@arki/journal`). Pass the
 * root handle, never a transaction: storage I/O must not run inside one.
 */
export type FilesDb = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

export type FilesContext = {
  readonly db: FilesDb;
  readonly adapter: SignedUploadAdapter;
  readonly files: FilesTable;
  readonly bucket: string;
};

/** Lifecycle at DEBUG, store failures at WARN. Never URLs, credentials or bytes. */
export const filesLog = getLogger('arki:fs');

export function fail(code: FileErrorCode, message: string, cause?: unknown): never {
  throw new FileStorageError(code, message, cause === undefined ? undefined : { cause });
}
