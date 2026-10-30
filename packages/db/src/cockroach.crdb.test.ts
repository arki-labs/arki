/**
 * The core of @arki/db against a real CockroachDB (Tier 0 claim: it speaks the Postgres wire
 * protocol well enough for createDb, runTransaction, unique-violation classification and migrations).
 *
 * Off by default because the image is large. Run with:
 *   ARKI_DB_CRDB=1 bun run test -- src/cockroach.crdb.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StartedTestContainer } from 'testcontainers';
import { defineRelations, eq, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { isUniqueViolation } from './errors.js';
import { createDb } from './factory.js';
import { migrateDb } from './migrate.js';
import { listenOnPool } from './pg-listen.js';
import { runTransaction } from './transaction.js';

// CockroachDB plain INT is 64-bit, which node-postgres returns as a string; the test table uses int4.
const COCKROACH_IMAGE = 'cockroachdb/cockroach:v26.3.3';

const counters = pgTable('crdb_counters', {
  id: text('id').primaryKey(),
  value: integer('value').notNull(),
});
const relations = defineRelations({ counters });

describe.runIf(process.env['ARKI_DB_CRDB'] === '1')('@arki/db on CockroachDB', () => {
  let container: StartedTestContainer | undefined;
  let url: string;
  let migrationsFolder: string;
  const databases: ReturnType<typeof createDb<typeof relations>>[] = [];

  const open = () => {
    const db = createDb({ relations, url });
    databases.push(db);
    return db;
  };

  beforeAll(async () => {
    container = await new GenericContainer(COCKROACH_IMAGE)
      .withCommand(['start-single-node', '--insecure'])
      .withExposedPorts(26_257)
      .withWaitStrategy(Wait.forLogMessage(/nodeID:|CockroachDB node starting/))
      .start();
    url = `postgresql://root@${container.getHost()}:${container.getMappedPort(26_257)}/defaultdb?sslmode=disable`;

    const probe = new pg.Pool({ connectionString: url, max: 1 });
    probe.on('error', () => null);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await probe.query('select 1');
        break;
      } catch (error) {
        if (attempt >= 60) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    await probe.query('create table crdb_counters (id text primary key, value int4 not null)');
    await probe.end();

    migrationsFolder = mkdtempSync(path.join(tmpdir(), 'arki-db-crdb-'));
    const first = path.join(migrationsFolder, '20260101000000_widgets');
    const second = path.join(migrationsFolder, '20260102000000_widget_seed');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(
      path.join(first, 'migration.sql'),
      'CREATE TABLE "widgets" ("id" text PRIMARY KEY, "label" text NOT NULL);\n',
    );
    writeFileSync(
      path.join(second, 'migration.sql'),
      'ALTER TABLE "widgets" ADD COLUMN "note" text;\n--> statement-breakpoint\nINSERT INTO "widgets" ("id", "label", "note") VALUES (\'w1\', \'first\', \'n\');\n',
    );
  }, 300_000);

  afterAll(async () => {
    await Promise.all(databases.map(db => db.$client.end()));
    if (migrationsFolder) rmSync(migrationsFolder, { recursive: true, force: true });
    await container?.stop();
  }, 60_000);

  // Why: the basic claim that createDb plus RQBv2 works over CockroachDB's wire protocol.
  it('createDb: insert and relational query round trip', async () => {
    const db = open();
    await db.insert(counters).values({ id: 'round-trip', value: 7 });
    const row = await db.query.counters.findFirst({ where: { id: 'round-trip' } });
    expect(row).toEqual({ id: 'round-trip', value: 7 });
  });

  // Why: CockroachDB is always SERIALIZABLE and reports conflicts as 40001; the retry loop must absorb them.
  it('runTransaction: concurrent read-modify-write both succeed, one retries', async () => {
    const db = open();
    await db.insert(counters).values({ id: 'hot', value: 0 });
    const seen: number[] = [];
    let arrived = 0;
    const both = Promise.withResolvers<void>();
    const increment = async () =>
      runTransaction(db, async (tx, attempt) => {
        seen.push(attempt);
        const [row] = await tx.select().from(counters).where(eq(counters.id, 'hot'));
        if (attempt === 1) {
          arrived += 1;
          if (arrived === 2) both.resolve();
          await both.promise;
        }
        await tx
          .update(counters)
          .set({ value: (row?.value ?? 0) + 1 })
          .where(eq(counters.id, 'hot'));
        return attempt;
      });
    const results = await Promise.all([increment(), increment()]);
    expect(results.every(result => typeof result === 'number')).toBe(true);
    expect(Math.max(...seen)).toBeGreaterThan(1);
    const final = await db.query.counters.findFirst({ where: { id: 'hot' } });
    expect(final?.value).toBe(2);
  }, 60_000);

  // Why: apps map duplicate keys to CONFLICT through isUniqueViolation, which reads SQLSTATE 23505.
  it('duplicate insert is classified as a unique violation', async () => {
    const db = open();
    await db.insert(counters).values({ id: 'dup', value: 1 });
    const error = await db
      .insert(counters)
      .values({ id: 'dup', value: 2 })
      .catch((error_: unknown) => error_);
    expect(error).toBeDefined();
    expect(isUniqueViolation(error)).toBe(true);
  });

  // Why: deploys run migrateDb; it must create the drizzle bookkeeping table and apply steps in order.
  it('migrateDb applies a two-step folder and records both in drizzle.__drizzle_migrations', async () => {
    const db = open();
    expect(await migrateDb(db, { migrationsFolder })).toBeUndefined();
    const widgets = await db.execute(sql`select id, label, note from widgets`);
    expect(widgets.rows).toEqual([{ id: 'w1', label: 'first', note: 'n' }]);
    const applied = await db.execute(sql`select count(*)::int4 as n from drizzle.__drizzle_migrations`);
    expect(applied.rows[0]).toEqual({ n: 2 });
    expect(await migrateDb(db, { migrationsFolder })).toBeUndefined();
  }, 60_000);

  // Why: records a known gap. CockroachDB has no LISTEN/NOTIFY, so hosts on it must use polling.
  it('listenOnPool start rejects (CockroachDB has no LISTEN)', async () => {
    const db = open();
    const start = listenOnPool(db.$client, 'x');
    await expect(start(vi.fn())).rejects.toThrow(/LISTEN/i);
  });
});
