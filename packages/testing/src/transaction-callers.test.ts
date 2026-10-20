// Fixture setup needs concrete IDs; abort setup if secure generation fails.
import { orThrow } from '@arki/failure';
/**
 * Callers follow the test transaction
 *
 * `asUser()`, `asAdmin()` and the other caller helpers used to hand out callers built at
 * setup, on the base connection. A write through such a caller inside `withTransaction`
 * skipped the test transaction, and could wait forever on a lock the transaction held.
 *
 * The check reads from the base connection while the transaction is still open. Rows written
 * in the transaction are not committed yet, so the base connection must not see them.
 * These tests run against a real Postgres (a container, unless a global connection string is set).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import { isNotNull } from 'drizzle-orm';
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createUserId } from '@arki/auth/ids';
import { initDb } from '@arki/db/builder';

import type { TestUser } from './types';
import { initTester } from './tester-builder';

const widgets = pgTable('widgets', { id: serial('id').primaryKey(), name: text('name').notNull() });
const schema = { widgets };

type Handle = NodePgDatabase<AnyRelations> | NodePgTransaction<AnyRelations>;
type Context = { db: Handle };
type Caller = { addWidget(name: string): Promise<void> };

const user: TestUser = { id: orThrow(createUserId()), email: 'test@example.com', name: 'Test' };

const t = initTester
  .context<Context>()
  .caller<Caller>()
  .create({
    schema,
    migrationsFolder: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/migrations'),
    createDatabase: connectionString => initDb.schema(schema).create({ connectionString, isDev: true }).db,
    createRepositories: (db: Handle) => ({
      async countWidgets(): Promise<number> {
        const rows = await db.select({ id: widgets.id }).from(widgets);
        return rows.length;
      },
    }),
    createContext: ({ db }) => ({ db }),
    createCaller: ({ context }) => ({
      async addWidget(name) {
        await context.db.insert(widgets).values({ name });
      },
    }),
    defaultUsers: { user, moderator: user, admin: user },
  });

const tester = t.tester.create();

async function countWidgets(): Promise<number> {
  const rows = await tester.db.select({ id: widgets.id }).from(widgets);
  return rows.length;
}

describe('callers inside withTransaction', () => {
  beforeAll(async () => {
    await tester.setup();
  }, 120_000);

  afterAll(async () => {
    await tester.teardown();
  });

  afterEach(async () => {
    await tester.db.delete(widgets).where(isNotNull(widgets.id));
  });

  it.each([
    ['asUser', () => tester.asUser().caller],
    ['asModerator', () => tester.asModerator().caller],
    ['asAdmin', () => tester.asAdmin().caller],
    ['asGuest', () => tester.asGuest()],
    ['caller.user', () => tester.caller.user],
    ['caller.public', () => tester.caller.public],
  ])('%s writes inside the test transaction, not on the base connection', async (_name, getCaller) => {
    await tester.withTransaction(async () => {
      await getCaller().addWidget('uncommitted');

      expect(await countWidgets()).toBe(0);
    });
  });

  it('repo and currentDb read what a caller wrote in the same transaction', async () => {
    await tester.withTransaction(async () => {
      await tester.asUser().caller.addWidget('uncommitted');

      expect(await tester.repo.countWidgets()).toBe(1);
      const rows = await tester.currentDb.select({ id: widgets.id }).from(widgets);
      expect(rows).toHaveLength(1);
      expect(await countWidgets()).toBe(0);
    });
  });

  it('still writes on the base database outside a transaction', async () => {
    await tester.asUser().caller.addWidget('kept');

    expect(await countWidgets()).toBe(1);
  });

  it('rolls back what a callback wrote through currentDb, repo and a caller', async () => {
    await tester.withTransaction(async () => {
      await tester.currentDb.insert(widgets).values({ name: 'via currentDb' });
      await tester.asUser().caller.addWidget('via caller');

      expect(await tester.repo.countWidgets()).toBe(2);
    });

    expect(await countWidgets()).toBe(0);
    expect(await tester.repo.countWidgets()).toBe(0);
  });

  it('rolls back and rethrows the callback error unchanged', async () => {
    const failure = new Error('callback failed');

    await expect(
      tester.withTransaction(async () => {
        await tester.currentDb.insert(widgets).values({ name: 'doomed' });
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(await countWidgets()).toBe(0);
  });

  it('leaves no transaction open after a rollback', async () => {
    await tester.withTransaction(async () => {
      await tester.currentDb.insert(widgets).values({ name: 'gone' });
    });

    expect(tester.currentDb).toBe(tester.db);
  });
});
