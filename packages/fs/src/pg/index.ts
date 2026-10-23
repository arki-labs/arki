/**
 * `@arki/fs/pg`: the files table on Postgres. The table factory, the
 * lifecycle (`fileStorage`) and the sweep. Server only.
 */
export type { CleanupOptions, CleanupResult } from '../lifecycle/cleanup.js';
export { toFileRecord } from '../lifecycle/record.js';
export type { FilePolicy, FileStorage, FileStorageOptions } from '../lifecycle/storage.js';
export { filesTable } from '../lifecycle/table.js';
export type { FileRow, FilesTable, FilesTableOptions, OwnerOf } from '../lifecycle/table.js';
export { fileStorage } from './storage.js';
export type { FilesDb } from './storage.js';
