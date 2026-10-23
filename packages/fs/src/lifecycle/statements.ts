/**
 * The database statements the files lifecycle runs. Drizzle's Postgres and
 * SQLite builders are different classes, so each dialect writes these once
 * (`../pg/storage.ts`, `../sqlite/storage.ts`) and the lifecycle around them
 * (`./storage.ts`, `./cleanup.ts`) is shared. Every deadline is computed from
 * the database clock.
 */
import type { FileId } from '../files/schemas.js';
import type { FileRow, FilesTable } from './table.js';

/** What a dialect's statements need from the parsed `fileStorage` options. */
export type StatementConfig = {
  /** Every statement only sees rows of this binding. */
  readonly bucket: string;
  /** How long after a PUT URL expires an upload may still land. */
  readonly graceSeconds: number;
};

/** The columns the lifecycle sets on a new row; the statement adds bucket, status and deadlines. */
export type PendingFile<T extends FilesTable> = Pick<FileRow<T>, 'id' | 'ownerId' | 'key' | 'mime' | 'size'>;

export type FileStatements<T extends FilesTable> = {
  /** The row with this id in the bound bucket. */
  read(id: FileId): Promise<FileRow<T> | undefined>;
  /**
   * Inserts a pending row. Its PUT URL dies `ttlSeconds` from now and the
   * sweep may act `graceSeconds` after that. Returns the URL's deadline.
   */
  insertPending(file: PendingFile<T>, ttlSeconds: number): Promise<FileRow<T>['expiresAt'] | undefined>;
  /** pending → deleting, due once a late PUT can no longer land. */
  reject(id: FileId): Promise<void>;
  /** pending → ready, only while the confirm window (`cleanup_at`) is open. */
  markReady(id: FileId, proof: Pick<FileRow<T>, 'etag' | 'sha256'>): Promise<FileRow<T> | undefined>;
  /**
   * pending or ready → deleting. A pending object may still receive a PUT until
   * `expires_at` + grace, so it is due only after that; a ready one is due now.
   */
  markDeleting(id: FileId): Promise<(Pick<FileRow<T>, 'key'> & { due: boolean }) | undefined>;
  /** Deletes the row, only while it is deleting. */
  deleteRow(id: FileId): Promise<void>;
  /**
   * Claims up to `batch` due rows (`status <> 'ready'` and `cleanup_at <= now`),
   * oldest first. The claim pushes `cleanup_at` out with backoff (1 min,
   * doubling, at most 1 day), so a failing object cannot starve later rows and
   * two sweepers never take the same row.
   */
  claimDue(batch: number): Promise<Pick<FileRow<T>, 'id' | 'key'>[]>;
};
