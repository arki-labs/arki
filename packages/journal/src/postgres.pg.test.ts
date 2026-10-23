/**
 * The read order of `postgresEvents` while appends overlap, on real Postgres (two connections).
 * Appends to different entities run in parallel, so a row can commit after a later one. A reader
 * that moved its cursor past the later row would never see the earlier one. Needs Docker: starts
 * a `postgres:16` container through testcontainers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EventLogPosition, EventToAppend } from './event-log.js';
import { eventLogTables } from './pg.js';
import { postgresEvents } from './postgres.js';

let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: NodePgDatabase;
let dbB: NodePgDatabase;
const storeTables = eventLogTables();

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  const connectionString = container.getConnectionUri();
  poolA = new pg.Pool({ connectionString, max: 1 });
  poolB = new pg.Pool({ connectionString, max: 1 });
  dbA = drizzle({ client: poolA });
  dbB = drizzle({ client: poolB });
  const { apply } = await pushSchema(storeTables, dbA);
  await apply();
}, 120_000);

afterAll(async () => {
  await poolA.end();
  await poolB.end();
  await container.stop();
});

const eventOf = (seq: number, entityId: string): EventToAppend => ({
  seq,
  id: `evt_overlap_${seq}`,
  kind: 'overlap',
  entityId,
  version: 1,
  type: 'Placed',
  data: {},
  meta: {},
  recordedAt: new Date(),
  commandId: null,
  causeSeq: null,
  correlationId: null,
  schemaVersion: 1,
});

describe('postgresEvents all', () => {
  it('never moves a cursor past an append that commits later', async () => {
    // Why: A appends first and stays open; B appends after it and commits. A read now sees B's
    // row, but A's will commit behind it. Ordering by transaction id and reading only below the
    // oldest open transaction holds B back until A ends, so a reader that keeps its `next` sees
    // both, A's first. Without the horizon the cursor passes B and A's event is lost for good.
    const reader = postgresEvents({ db: dbB, tables: storeTables });
    const all = reader.all;
    if (all === undefined) throw new Error('postgresEvents has a global order');
    const held = Promise.withResolvers<void>();
    const inA = Promise.withResolvers<void>();
    const a = dbA.transaction(async tx => {
      await postgresEvents({ db: tx, tables: storeTables }).append({
        kind: 'overlap',
        entityId: 'a',
        expectedVersion: 0,
        events: [eventOf(20, 'a')],
      });
      inA.resolve();
      await held.promise;
    });
    await inA.promise;
    await reader.append({ kind: 'overlap', entityId: 'b', expectedVersion: 0, events: [eventOf(10, 'b')] });

    const seen: string[] = [];
    let position: EventLogPosition | null = null;
    const read = async () => {
      const page = await all.after(position, { kinds: ['overlap'], limit: 10 });
      seen.push(...page.events.map(event => event.entityId));
      position = page.next;
    };
    await read();
    expect(seen).toEqual([]);

    held.resolve();
    await a;
    await read();
    expect(seen).toEqual(['a', 'b']);
    await read();
    expect(seen).toEqual(['a', 'b']);
  });
});
