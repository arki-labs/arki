/**
 * clearAllTables
 *
 * A schema module also exports relations, enums and other objects. Only tables are cleared:
 * handing anything else to `db.delete` throws, so one extra export would break every test
 * that resets its data.
 */
import { defineRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import { integer, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { startPostgresContainer } from '@arki/testing/containers';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import { createUserId } from '../../ids.js';

import { IntegrationTester } from './integration-tester.js';
import type { TestUser } from './types.js';

const widgets = pgTable('widgets', { id: integer('id').primaryKey(), name: text('name').notNull() });
const widgetKind = pgEnum('widget_kind', ['small', 'large']);
const relations = defineRelations({ widgets }, () => ({}));
const schema = { widgets, widgetKind, relations };

type AppDb = NodePgDatabase<typeof relations>;
type Handle = AppDb | NodePgTransaction<typeof relations>;

const testUser: TestUser = { id: orThrow(createUserId()), email: 'test@example.com', name: 'Test' };

class AttachedTester extends IntegrationTester<
  typeof schema,
  AppDb,
  Record<string, never>,
  null,
  Record<string, never>,
  Handle
> {
  attach(db: AppDb): void {
    this._db = db;
  }
}

describe('IntegrationTester.clearAllTables', () => {
  let stop: () => Promise<void> = () => Promise.resolve();
  let db: AppDb | undefined;

  beforeAll(async () => {
    const container = await startPostgresContainer();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle({ client: pool, relations });
    stop = async () => {
      await pool.end();
      await container.stop();
    };
    await db.execute(sql`create table widgets (id integer primary key, name text not null)`);
    await db.insert(widgets).values({ id: 1, name: 'one' });
  }, 120_000);

  afterAll(async () => {
    await stop();
  });

  it('empties the tables and skips relations and enums exported next to them', async () => {
    const database = db;
    if (database === undefined) throw new Error('database not started');
    const tester = new AttachedTester({
      schema,
      migrationsFolder: '',
      createDatabase: () => database,
      createContext: () => ({}),
      createCaller: () => null,
      createRepositories: () => ({}),
      defaultUsers: { user: testUser, moderator: testUser, admin: testUser },
    });
    tester.attach(database);

    await tester.clearAllTables();

    expect(await database.select().from(widgets)).toEqual([]);
  });
});
