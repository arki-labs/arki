/**
 * The lease fence on real Postgres with two workers on two connections. PGlite has one connection, so it cannot
 * show a claim waiting for a command in flight, or two owners of one job at once; this file does.
 * Needs Docker: starts a `postgres:16` container through testcontainers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';

import { isJournalError } from './errors.js';
import { j, meta, order, OrderNoted, OrderPaid, OrderPlaced, orders, tables } from './test-support.js';

let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: NodePgDatabase;
let dbB: NodePgDatabase;
let next = 0;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const noop = (): void => {
  // Replaced by the promise's resolver before the gate is returned.
};

/** A promise a test settles by hand, to hold a handler at a chosen point. */
function gate() {
  let open = noop;
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  return { opened, open };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  poolA = new pg.Pool({ connectionString: container.getConnectionUri(), max: 3 });
  poolB = new pg.Pool({ connectionString: container.getConnectionUri(), max: 3 });
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

beforeEach(async () => {
  await dbA.delete(tables.jobs).where(sql`true`);
  await dbA.delete(tables.jobArchive).where(sql`true`);
});

/** What each worker does in its turn, and the gates that hold it. Set by each test before the drains start. */
type Script = {
  /** Resolves when the worker's handler has started. */
  readonly started: ReturnType<typeof gate>;
  /** Holds the handler (or the command in flight) until the test lets it go. */
  readonly hold: ReturnType<typeof gate>;
  readonly outcome: string[];
};
const script = (): Script => ({ started: gate(), hold: gate(), outcome: [] });
let first = script();
let second = script();
let calls = 0;
/** 'handler': the worker waits before running its command. 'command': it waits inside the command's transaction. */
let holdAt: 'handler' | 'command' = 'handler';

const noteOrder = j.command(
  'noteOrder',
  z.object({ orderId: z.templateLiteral(['ord_', z.string()]), note: z.string().min(1) }),
  async (input, { write }) => {
    if (holdAt === 'command' && input.note === 'first') {
      first.started.open();
      await first.hold.opened;
    }
    return write(order, input.orderId, () => [OrderNoted({ note: input.note })]);
  },
);

const racer = j.effect('racer', order, {
  OrderPaid: async (event, ctx) => {
    calls += 1;
    const mine = calls === 1 ? first : second;
    const note = calls === 1 ? 'first' : 'second';
    if (holdAt === 'handler') {
      mine.started.open();
      await mine.hold.opened;
    }
    try {
      orThrow(await ctx.run(noteOrder, { orderId: event.entityId, note }, meta));
      mine.outcome.push('committed');
    } catch (error) {
      mine.outcome.push(isJournalError(error, 'LEASE_LOST') ? 'LEASE_LOST' : 'other');
      throw error;
    }
  },
});
const journal = j.compose({ effects: [racer] });

async function payOrder() {
  const id: `ord_${number}` = `ord_${++next}`;
  orThrow(
    await dbA.transaction(tx =>
      journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
    ),
  );
  orThrow(
    await dbA.transaction(tx => journal.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 1 })] })),
  );
  return id;
}

const notesOf = async (id: string) => {
  const rows = await dbA
    .select({ type: tables.events.type, data: tables.events.data })
    .from(tables.events)
    .where(eq(tables.events.entityId, id))
    .orderBy(asc(tables.events.seq));
  return rows.filter(row => row.type === 'OrderNoted').map(row => z.object({ note: z.string() }).parse(row.data).note);
};

/** The lease runs out while the first worker is stalled, as after a long pause or a lost network. */
const expireLease = () =>
  dbB
    .update(tables.jobs)
    .set({ leaseUntil: sql`now() - interval '1 second'` })
    .where(sql`true`);

beforeEach(() => {
  first = script();
  second = script();
  calls = 0;
  holdAt = 'handler';
});

describe('the lease fence on real Postgres', () => {
  it('a worker whose lease expired and whose job was reclaimed gets LEASE_LOST and writes nothing, while the new owner commits', async () => {
    const id = await payOrder();
    const stale = journal.drain(dbA, { leaseSeconds: 1 });
    await first.started.opened;
    await expireLease();
    const owner = journal.drain(dbB, { leaseSeconds: 1 });
    await second.started.opened;
    // The stale worker wakes up after the takeover and tries to write.
    first.hold.open();
    await stale;
    expect(first.outcome).toEqual(['LEASE_LOST']);
    expect(await notesOf(id)).toEqual([]);
    second.hold.open();
    await owner;
    expect(second.outcome).toEqual(['committed']);
    expect(await notesOf(id)).toEqual(['second']);
  }, 20_000);

  it('a claim waits for a command already in flight, so a stale write is either whole before the takeover or refused', async () => {
    const id = await payOrder();
    holdAt = 'command';
    const stale = journal.drain(dbA, { leaseSeconds: 1 });
    // The first worker is now inside the command's transaction, holding its fence lock on the open attempt.
    await first.started.opened;
    await expireLease();
    let claimed = false;
    const owner = journal.drain(dbB, { leaseSeconds: 1 }).then(count => {
      claimed = true;
      return count;
    });
    await sleep(500);
    expect(claimed).toBe(false);
    first.hold.open();
    await stale;
    await owner;
    expect(first.outcome).toEqual(['committed']);
    expect(second.outcome).toEqual(['committed']);
    expect(await notesOf(id)).toEqual(['first', 'second']);
  }, 20_000);
});
