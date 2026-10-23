/**
 * Auth tables with one extra session column, `appContext`: the app a session belongs to, as
 * games-platform and kapodopera write it on every new session.
 */
import { pgSchema } from 'drizzle-orm/pg-core';

import { pgColumns } from '@arki/db/pg';

import { authIdSources } from '../pg/ids.js';
import { createAuthTables } from '../schema/auth-tables.js';

const c = pgColumns(pgSchema('games'));

export const sessionTables = createAuthTables(c, {
  fill: 'app',
  ids: authIdSources,
  columns: { session: { appContext: c.varchar('app_context', { length: 50 }) } },
});
