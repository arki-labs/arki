/**
 * `@arki/auth/sqlite` — the same runtime as `@arki/auth/pg`, on SQLite (libSQL). Node and Bun.
 * The tables are the same `createAuthTables`, built with the SQLite column kit; the engine reads
 * the dialect from `db`.
 *
 * @example
 * const c = sqliteColumns({ prefix: 'auth_' });
 * export const authTables = createAuthTables(c, { fill: 'app', ids: authIdSources });
 * const { db } = createLibsqlDb({ url: 'file:app.db', relations });
 * export const auth = createAuth(authDefinition, { db, tables: authTables, mail, runtime });
 */
export * from '../runtime.js';
export { accountIdColumns, authIdSources, sessionIdColumns, userIdColumns, verificationIdColumns } from './ids.js';
