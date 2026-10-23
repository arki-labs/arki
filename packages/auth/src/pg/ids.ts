/**
 * The Drizzle columns of the auth id kinds, for the app's own tables: `userIdColumns.primaryColumn()`,
 * `userIdColumns.createForeignKeyFactory(() => User.id)`, `userIdColumns.reference('user_id')`.
 * `authIdSources` are the same ids as column kit specs, for `createAuthTables`.
 *
 * Column helpers only. Make ids with `create*Id` from `@arki/auth/ids`; check them with the
 * schemas on `@arki/auth/zod`.
 */
import { idColumns } from '@arki/db/id';
import { pgColumns } from '@arki/db/pg';

import { accountId, sessionId, userId, verificationId } from '../id-declarations.js';

export const userIdColumns = idColumns(userId);
export const sessionIdColumns = idColumns(sessionId);
export const accountIdColumns = idColumns(accountId);
export const verificationIdColumns = idColumns(verificationId);

// A spec does not depend on the table's schema, so one schema-less kit makes them for every app.
const kit = pgColumns();

/**
 * The auth id kinds as `createAuthTables` takes them: `varchar(256)` primary keys, and foreign keys
 * to the user from `userForeignKeys` as plain Postgres columns for the app's own tables.
 */
export const authIdSources = {
  user: { primaryColumn: () => kit.id(userId).primaryColumn(), createForeignKeyFactory: userIdColumns.createForeignKeyFactory },
  session: kit.id(sessionId),
  account: kit.id(accountId),
  verification: kit.id(verificationId),
};
