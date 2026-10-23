/**
 * The same files table and lifecycle on SQLite (libSQL). Typechecked with the
 * package; the README's SQLite block is copied from here.
 */
import { sqliteColumns } from '@arki/db/sqlite';

import type { FilesDb } from '../../src/sqlite/index.js';
import type { SignedUploadAdapter } from '../../src/storage/types.js';
import { filesTable, fileStorage } from '../../src/sqlite/index.js';
import { userId } from './server.js';

// model/tables.ts (server): the same table on the SQLite kit; `prefix` stands in for a Postgres schema
export const files = filesTable(sqliteColumns({ prefix: 'storage_' }), { owner: userId });

// infra (boot): `db` is the root handle from `createLibsqlDb({ url: 'file:app.db', relations })`
export function buildStorage(db: FilesDb, adapter: SignedUploadAdapter) {
  return fileStorage(db, adapter, {
    files,
    bucket: 'uploads',
    limits: { maxSize: 20_000_000, allowedMime: ['image/*', 'application/pdf'] },
  });
}
