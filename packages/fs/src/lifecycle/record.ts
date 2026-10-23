/**
 * The client view of a row. Type-only imports, so `@arki/fs/orpc` can use it
 * without pulling Drizzle into a browser bundle.
 */
import type { FileRecord } from '../files/schemas.js';
import type { FileRow, FilesTable } from './table.js';

/** A row as clients see it: no bucket, key, owner or etag. */
export function toFileRecord(row: FileRow<FilesTable>): FileRecord {
  return {
    id: row.id,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    status: row.status,
    createdAt: row.createdAt.toString(),
  };
}
