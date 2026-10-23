/**
 * The built-in log keeps the event log contract: the suite every log adapter must pass runs
 * against `journal_events` on PGlite, one emptied table per case.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { ContractSkip, eventLogContract } from './event-log-contract.js';
import { createBuiltInEventLog } from './store.js';
import { tables } from './test-support.js';
import { openJournalDb } from './testing.js';

let db: PgliteDatabase;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openJournalDb({ ...tables }));
});
afterAll(async () => {
  await client.close();
});

const log = createBuiltInEventLog({ tables });

describe('the built-in event log keeps the event log contract', () => {
  for (const contractCase of eventLogContract(async () => {
    // The cases stamp their own seqs from 1, so each starts on an empty table.
    await db.execute(sql`truncate ${tables.events} restart identity cascade`);
    return { log, db };
  })) {
    it(contractCase.name, async context => {
      try {
        await contractCase.run();
      } catch (error) {
        if (error instanceof ContractSkip) context.skip(error.message);
        throw error;
      }
    });
  }
});
