/**
 * T(journal-foreman-receipts-pg) — the receipt store on real Postgres, with several connections. Why it
 * matters: a claim that loses a race for one execution id must answer "already claimed" with the
 * winner's receipt, so the dispatcher never runs the action twice and never fails an execute that is
 * only a repeat. PGlite has one connection and cannot show two claims racing.
 * Needs Docker: starts a `postgres:16` container through testcontainers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { PendingReceipt } from '@arki/admin/receipts';

import { initJournal } from '../index.js';
import { journalTables } from '../pg.js';
import { foremanReceiptTables, journalReceiptStore } from './receipts.js';

const T0 = '2026-10-14T12:00:00.000Z';
const tables = journalTables();
const receiptTables = foremanReceiptTables();

let container: StartedPostgreSqlContainer;
let connectionString: string;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: NodePgDatabase;
let dbB: NodePgDatabase;

/** One store per connection, each on its own journal, the way two app processes build it. */
function storeOn(db: NodePgDatabase) {
  const j = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
  return journalReceiptStore({ j, journal: j.compose({}), db, tables: receiptTables, meta: { actorId: 'foreman' } });
}

const pendingFor = (executionId: string): PendingReceipt => ({
  status: 'pending',
  executionId,
  actionId: 'queue.retryJob',
  claimedAt: T0,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  connectionString = container.getConnectionUri();
  poolA = new pg.Pool({ connectionString, max: 1 });
  poolB = new pg.Pool({ connectionString, max: 1 });
  dbA = drizzle({ client: poolA });
  dbB = drizzle({ client: poolB });
  const { apply } = await pushSchema({ ...tables, ...receiptTables }, dbA);
  await apply();
}, 120_000);

afterAll(async () => {
  await poolA.end();
  await poolB.end();
  await container.stop();
});

describe('T(journal-foreman-receipts-pg) claim races on real Postgres', () => {
  it("two claims for one id on two connections: one wins, the other gets the winner's receipt", async () => {
    const [storeA, storeB] = [storeOn(dbA), storeOn(dbB)];
    for (let round = 0; round < 5; round += 1) {
      const pending = pendingFor(`exe_race_${round}`);
      const results = await Promise.all([storeA.claim(pending), storeB.claim(pending)]);
      expect(results.filter(result => result.claimed)).toHaveLength(1);
      expect(results.filter(result => !result.claimed)).toEqual([{ claimed: false, receipt: pending }]);
    }
  }, 30_000);

  it('a claim that loses the insert to a writer outside the append lock returns that receipt, not a throw', async () => {
    // Why: the journal's append lock serialises its own writers, so the loser above reads the row. A
    // writer that skips the lock (another tool, a manual fix) makes the unique index the backstop:
    // the claim's insert waits on the open row, then fails as CONFLICT once it commits.
    const pending = pendingFor('exe_backstop');
    const outside = new pg.Client({ connectionString });
    await outside.connect();
    try {
      await outside.query('begin');
      await outside.query('insert into foreman_receipts (id, receipt, version) values ($1, $2, 1)', [
        pending.executionId,
        JSON.stringify(pending),
      ]);
      await outside.query(
        `insert into journal_events (id, kind, entity_id, version, type, data, meta)
         values ('evt_backstop', 'foreman_receipt', $1, 1, 'ForemanReceiptClaimed', $2, $3)`,
        [pending.executionId, JSON.stringify({ receipt: pending }), JSON.stringify({ actorId: 'outside' })],
      );
      const claim = storeOn(dbA).claim(pending);
      // Give the claim time to reach the insert and wait on the uncommitted row.
      await new Promise(resolve => setTimeout(resolve, 500));
      await outside.query('commit');
      expect(await claim).toEqual({ claimed: false, receipt: pending });
    } finally {
      await outside.end();
    }
  }, 30_000);
});
