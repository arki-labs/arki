/**
 * The core flows on libSQL: the same engine and the same flows as on PGlite
 * (`../pg/assemble.test.ts`), with the tables built by the SQLite column kit.
 */
import { describeAuthFlows, flowDefinitions } from '../__fixtures__/flows.js';
import { allTables, authTables } from '../__fixtures__/sqlite-tables.js';
import { testAuth } from '../testing/index.js';

describeAuthFlows(async kind =>
  kind === 'workspaces'
    ? testAuth(flowDefinitions.workspaces, { tables: allTables, database: 'libsql' })
    : testAuth(flowDefinitions[kind], { tables: authTables, database: 'libsql' }),
);
