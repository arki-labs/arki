/**
 * Auth tables with one extra session column, `appContext`: the app a session belongs to, as
 * games-platform and kapodopera write it on every new session.
 */
import { pgSchema, varchar } from 'drizzle-orm/pg-core';

import { accountIdColumns, sessionIdColumns, userIdColumns, verificationIdColumns } from '../pg/ids.js';
import { createAuthTables } from '../pg/schema/index.js';

export const sessionTables = createAuthTables(pgSchema('games'), {
  fill: 'app',
  ids: {
    user: userIdColumns,
    session: sessionIdColumns,
    account: accountIdColumns,
    verification: verificationIdColumns,
  },
  columns: { session: { appContext: varchar('app_context', { length: 50 }) } },
});
