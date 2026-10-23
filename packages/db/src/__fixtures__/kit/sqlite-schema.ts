/** The sample tables on SQLite, as an app's drizzle-kit schema file would export them. */
import { sqliteColumns } from '../../columns-sqlite.js';
import { noteTables } from './note-tables.js';

export const { notes, comments, noteEvents } = noteTables(sqliteColumns({ prefix: 'app_' }));
