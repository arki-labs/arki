/**
 * Auth tables with one extra session column, `appContext`: the app a session belongs to, as
 * games-platform and kapodopera write it on every new session.
 */
import { pgSchema, varchar } from 'drizzle-orm/pg-core';

import { accountIdFactory, sessionIdFactory, userIdFactory, userVerificationIdFactory } from '../ids.js';
import { createAuthTables } from '../schema/index.js';

export const sessionTables = createAuthTables(pgSchema('games'), {
  fill: 'app',
  ids: {
    user: userIdFactory,
    session: sessionIdFactory,
    account: accountIdFactory,
    verification: userVerificationIdFactory,
  },
  columns: { session: { appContext: varchar('app_context', { length: 50 }) } },
});
