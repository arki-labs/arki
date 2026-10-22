/**
 * Two creates of one transient entity id racing on real Postgres (two connections). With no event
 * row, the log's unique index cannot catch the second create; the row insert must. Needs Docker:
 * starts a `postgres:16` container through testcontainers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { count, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';

import { isJournalError } from './errors.js';
import { initJournal } from './journal.js';
import { meta, orderId, OrderPlaced, orders, tables } from './test-support.js';

let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: NodePgDatabase;
let dbB: NodePgDatabase;
let next = 0;

const jt = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }), events: 'transient' });
const draft = jt
  .entity('draft', orders)
  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }));
const journal = jt.compose({});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  const connectionString = container.getConnectionUri();
  poolA = new pg.Pool({ connectionString, max: 1 });
  poolB = new pg.Pool({ connectionString, max: 1 });
  dbA = drizzle({ client: poolA });
  dbB = drizzle({ client: poolB });
  const { apply } = await pushSchema({ ...tables, orders }, dbA);
  await apply();
}, 120_000);

afterAll(async () => {
  await poolA.end();
  await poolB.end();
  await container.stop();
});

const place = () => [OrderPlaced({ customerId: 'c', total: 1 })];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Resolves once some session waits on an advisory lock: the other writer is queued behind the append lock. */
async function untilAWriterWaits(db: Pick<NodePgDatabase, 'select'>) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const [waiting] = await db
      .select({ n: count() })
      .from(sql`pg_locks`)
      .where(sql`locktype = 'advisory' and not granted`);
    if ((waiting?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error('no writer queued behind the append lock');
    await sleep(20);
  }
}

describe('two creates of one transient id on real Postgres', () => {
  it('the loser gets CONFLICT, not a raw unique violation', async () => {
    // Why: a stored entity's second create fails on the log's (kind, entity_id, version) index and
    // is mapped to CONFLICT. A transient entity has no log row, so the row's own key is the only
    // thing that stops a double create. The caller must see the same code either way, so one
    // `isJournalError(error, 'CONFLICT')` covers both modes.
    // Repeatable read: B takes its snapshot while it waits on the append lock, so after A commits B
    // still loads "no row" and inserts. (At read committed B would see A's row and get ROW_EXISTS.)
    const id = orderId(++next);
    // A holds the append lock inside `events` until B is queued behind it, then commits. B's first
    // statement (the lock) started before A's commit, so B's snapshot never shows A's row.
    const writerA = dbA.transaction(
      async tx => {
        const result = await journal.write(tx, draft, id, {
          meta,
          events: async (_row, { tx: sp }) => {
            await untilAWriterWaits(sp);
            return place();
          },
        });
        return orThrow(result);
      },
      { isolationLevel: 'repeatable read' },
    );
    const writerB = dbB.transaction(tx => journal.write(tx, draft, id, { meta, events: place }), {
      isolationLevel: 'repeatable read',
    });
    const won = await writerA;
    expect(won.row?.version).toBe(1);
    await expect(writerB).rejects.toSatisfy((error: unknown) => isJournalError(error, 'CONFLICT'));
    const rows = await dbA.select().from(orders).where(eq(orders.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
  });
});
