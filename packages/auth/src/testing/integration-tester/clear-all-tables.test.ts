/**
 * clearAllTables, clearTablesExcept, clearTablesByPattern
 *
 * A schema module also exports relations, enums and other objects. Only tables are cleared:
 * handing anything else to `db.delete` throws, so one extra export would break every test
 * that resets its data. A schema exports parents before children as often as not: a parent
 * emptied while its child still holds rows is refused by the foreign key, so every app with a
 * foreign key could not reset its data between tests.
 */
import { defineRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import { integer, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { startPostgresContainer } from '@arki/testing/containers';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FAILURE_ERROR_CODES, orThrow } from '@arki/failure';

import { createUserId } from '../../ids.js';

import { IntegrationTester } from './integration-tester.js';
import type { TestUser } from './types.js';

const widgets = pgTable('widgets', { id: integer('id').primaryKey(), name: text('name').notNull() });
const widgetKind = pgEnum('widget_kind', ['small', 'large']);
// Exported parent first, then a child, then a grandchild that points at both.
const owners = pgTable('owners', { id: integer('id').primaryKey() });
const pets = pgTable('pets', {
  id: integer('id').primaryKey(),
  ownerId: integer('owner_id')
    .notNull()
    .references(() => owners.id),
});
const visits = pgTable('visits', {
  id: integer('id').primaryKey(),
  petId: integer('pet_id')
    .notNull()
    .references(() => pets.id),
  ownerId: integer('owner_id')
    .notNull()
    .references(() => owners.id),
});
// A child whose foreign key cascades: Postgres deletes its rows with the parent's, so it never blocks a clear.
const collars = pgTable('collars', {
  id: integer('id').primaryKey(),
  petId: integer('pet_id')
    .notNull()
    .references(() => pets.id, { onDelete: 'cascade' }),
});
const relations = defineRelations({ widgets, owners, pets, visits, collars }, () => ({}));
const schema = { widgets, widgetKind, owners, pets, visits, collars, relations };

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
    await db.execute(sql`create table owners (id integer primary key)`);
    await db.execute(sql`create table pets (id integer primary key, owner_id integer not null references owners(id))`);
    await db.execute(
      sql`create table visits (id integer primary key, pet_id integer not null references pets(id), owner_id integer not null references owners(id))`,
    );
    await db.execute(
      sql`create table collars (id integer primary key, pet_id integer not null references pets(id) on delete cascade)`,
    );
  }, 120_000);

  afterAll(async () => {
    await stop();
  });

  /** The started database, holding one widget and an owner with a pet and a visit. */
  async function seeded() {
    const database = db;
    if (database === undefined) throw new Error('database not started');
    await database.insert(widgets).values({ id: 1, name: 'one' });
    await database.insert(owners).values({ id: 1 });
    await database.insert(pets).values({ id: 1, ownerId: 1 });
    await database.insert(visits).values({ id: 1, petId: 1, ownerId: 1 });
    await database.insert(collars).values({ id: 1, petId: 1 });
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
    return { database, tester };
  }

  it('empties every table, children before the parents they reference, and skips relations and enums', async () => {
    const { database, tester } = await seeded();

    await tester.clearAllTables();

    expect(await database.select().from(widgets)).toEqual([]);
    expect(await database.select().from(owners)).toEqual([]);
    expect(await database.select().from(pets)).toEqual([]);
    expect(await database.select().from(visits)).toEqual([]);
  });

  it('clearTablesExcept empties a parent and its children in foreign-key order', async () => {
    const { database, tester } = await seeded();

    await tester.clearTablesExcept(widgets);

    expect(await database.select().from(widgets)).toEqual([{ id: 1, name: 'one' }]);
    expect(await database.select().from(owners)).toEqual([]);
    await tester.clearAllTables();
  });

  it('clearTablesByPattern empties the matching parent and children in foreign-key order', async () => {
    const { database, tester } = await seeded();

    await tester.clearTablesByPattern(/^(owners|pets|visits)$/);

    expect(await database.select().from(widgets)).toEqual([{ id: 1, name: 'one' }]);
    expect(await database.select().from(visits)).toEqual([]);
    expect(await database.select().from(collars)).toEqual([]);
    await tester.clearAllTables();
  });

  // Why (audit-3 #9): a set that leaves out a table referencing one it clears made Postgres refuse the parent's
  // delete half-way through, as a raw 23503 after some tables were already emptied. It is the caller's bug, so it
  // is the invariant failure, named with the missing tables, before any row is deleted.
  it('refuses, before deleting anything, a set that leaves out a table referencing a cleared one', async () => {
    const { database, tester } = await seeded();
    const invariantBroken = expect.objectContaining({ code: FAILURE_ERROR_CODES.invariant });

    await expect(tester.clearTablesByPattern(/^(owners|pets)$/)).rejects.toThrow(invariantBroken);
    await expect(tester.clearTablesByPattern(/^(owners|pets)$/)).rejects.toThrow(/without visits/);
    await expect(tester.clearTables(owners)).rejects.toThrow(invariantBroken);
    await expect(tester.clearTablesExcept(visits)).rejects.toThrow(invariantBroken);

    expect(await database.select().from(owners)).toEqual([{ id: 1 }]);
    expect(await database.select().from(pets)).toEqual([{ id: 1, ownerId: 1 }]);
    await tester.clearAllTables();
  });

  // Why (audit-3 #9): `test` on a `g` or `y` RegExp resumes at `lastIndex`, so every other matching table was skipped.
  it.each([/^(owners|pets|visits)$/g, /^(owners|pets|visits)$/y])('a %s pattern still clears every matching table', async pattern => {
    const { database, tester } = await seeded();

    await tester.clearTablesByPattern(pattern);

    expect(await database.select().from(owners)).toEqual([]);
    expect(await database.select().from(pets)).toEqual([]);
    expect(await database.select().from(visits)).toEqual([]);
    expect(await database.select().from(widgets)).toEqual([{ id: 1, name: 'one' }]);
    await tester.clearAllTables();
  });

  it('a string pattern that is not a regular expression is the invariant failure, not a raw SyntaxError', async () => {
    const { tester } = await seeded();

    await expect(tester.clearTablesByPattern('(')).rejects.toThrow(
      expect.objectContaining({ code: FAILURE_ERROR_CODES.invariant }),
    );
    await tester.clearAllTables();
  });
});
