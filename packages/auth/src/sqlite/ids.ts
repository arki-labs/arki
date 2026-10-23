/**
 * The SQLite columns of the auth id kinds, for the app's own tables: `userIdColumns.primaryColumn()`,
 * `userIdColumns.createForeignKeyFactory(() => User.id)`, `userIdColumns.reference('user_id')`.
 * `authIdSources` are the same ids as column kit specs, for `createAuthTables`.
 *
 * Column helpers only. Make ids with `create*Id` from `@arki/auth/ids`; check them with the
 * schemas on `@arki/auth/zod`.
 */
import { idColumns, sqliteColumns } from '@arki/db/sqlite';

import { accountId, sessionId, userId, verificationId } from '../id-declarations.js';

export const userIdColumns = idColumns(userId);
export const sessionIdColumns = idColumns(sessionId);
export const accountIdColumns = idColumns(accountId);
export const verificationIdColumns = idColumns(verificationId);

// A spec does not depend on the table's prefix, so one prefix-less kit makes them for every app.
const kit = sqliteColumns();

/**
 * The auth id kinds as `createAuthTables` takes them, and foreign keys to the user from
 * `userForeignKeys` as plain SQLite columns for the app's own tables.
 */
export const authIdSources = {
  user: { primaryColumn: () => kit.id(userId).primaryColumn(), createForeignKeyFactory: userIdColumns.createForeignKeyFactory },
  session: kit.id(sessionId),
  account: kit.id(accountId),
  verification: kit.id(verificationId),
};
