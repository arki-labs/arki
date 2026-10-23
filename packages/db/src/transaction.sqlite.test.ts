/**
 * `runTransaction` and `createUnitOfWork` on SQLite (libSQL). The same contract
 * as on Postgres: a returned Failure rolls back, a lock conflict is retried, and
 * a driver that cannot keep an async callback's rollback is refused before it
 * runs anything.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createClient } from '@libsql/client';
import { defineRelations, sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { drizzle as drizzleProxy } from 'drizzle-orm/sqlite-proxy';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import { defineFailure, orThrow } from '@arki/failure';

import { createUnitOfWork } from './composition.js';
import { createLibsqlDb } from './libsql.js';
import { DB_TRANSACTION_ERROR_CODES, runTransaction } from './transaction.js';

const accounts = sqliteTable('accounts', { id: text('id').primaryKey(), balance: integer('balance').notNull() });
const relations = defineRelations({ accounts });
const Overdrawn = defineFailure('test.overdrawn');

let dir: string;
let file: string;
let opened: ReturnType<typeof createLibsqlDb<typeof relations>>;

const balanceOf = async (id: string) => {
  const account = await opened.db.query.accounts.findFirst({ where: { id } });
  return account?.balance;
};

describe('transactions on libSQL', () => {
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'arki-libsql-tx-'));
    file = `file:${path.join(dir, 'app.db')}`;
    opened = createLibsqlDb({ url: file, relations });
    await opened.db.run(sql`create table accounts (id text primary key, balance integer not null)`);
    await opened.db.insert(accounts).values({ id: 'a', balance: 100 });
  });

  afterEach(() => {
    opened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('commits ordinary work and rolls back a returned Failure, exactly as on Postgres', async () => {
    orThrow(
      await runTransaction(opened.db, async tx => {
        await tx.update(accounts).set({ balance: 90 }).where(sql`id = 'a'`);
      }),
    );
    expect(await balanceOf('a')).toBe(90);

    const outcome = await runTransaction(opened.db, async tx => {
      await tx.update(accounts).set({ balance: -10 }).where(sql`id = 'a'`);
      return Overdrawn();
    });
    expect(Overdrawn.is(outcome)).toBe(true);
    expect(await balanceOf('a')).toBe(90);
  });

  it('retries while another process holds the write lock, then commits', async () => {
    // A second client on the same file stands in for a second process: our queue cannot see it,
    // so its lock reaches us as SQLITE_BUSY, which reads as the retryable 40001.
    const other = createClient({ url: file });
    const held = await other.transaction('write');
    setTimeout(() => void held.commit(), 30);
    try {
      let attempts = 0;
      const outcome = await runTransaction(
        opened.db,
        async (tx, attempt) => {
          attempts = attempt;
          await tx.update(accounts).set({ balance: 50 }).where(sql`id = 'a'`);
        },
        { retries: 10 },
      );
      expect(outcome).toBeUndefined();
      expect(attempts).toBeGreaterThan(1);
      expect(await balanceOf('a')).toBe(50);
    } finally {
      other.close();
    }
  });

  it('runs a unit of work over libSQL, rolling back when it returns a Failure', async () => {
    const unitOfWork = createUnitOfWork(opened.db, { ledger: tx => tx });
    orThrow(
      await unitOfWork(async ({ ledger }) => {
        await ledger.update(accounts).set({ balance: 70 }).where(sql`id = 'a'`);
      }),
    );
    const refused = await unitOfWork(async ({ ledger }) => {
      await ledger.update(accounts).set({ balance: 0 }).where(sql`id = 'a'`);
      return Overdrawn();
    });
    expect(Overdrawn.is(refused)).toBe(true);
    expect(await balanceOf('a')).toBe(70);
  });

  it('types the work\'s transaction with this app\'s tables, as on Postgres', async () => {
    // Without inference, every query inside runTransaction would be untyped on SQLite.
    const found = orThrow(
      await runTransaction(opened.db, async tx => {
        expectTypeOf(tx.query.accounts).toHaveProperty('findFirst');
        return tx.select().from(accounts);
      }),
    );
    expectTypeOf(found).toEqualTypeOf<{ id: string; balance: number }[]>();
    expect(found).toEqual([{ id: 'a', balance: 100 }]);
  });
});

describe('unsafe SQLite drivers', () => {
  it('refuses a SQLite driver that is not libSQL before running any work', async () => {
    // Sync drivers commit when an async callback returns: a throw after an await would keep its writes.
    const proxy = drizzleProxy(() => Promise.resolve({ rows: [] }));
    let ran = false;
    await expect(
      runTransaction(proxy, () => {
        ran = true;
        return Promise.resolve();
      }),
    ).rejects.toMatchObject({ code: DB_TRANSACTION_ERROR_CODES.unsafeSqliteDriver });
    expect(ran).toBe(false);
  });
});
