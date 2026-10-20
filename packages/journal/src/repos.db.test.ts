/**
 * `repos()` inside a journal command. Repositories are the read side of a
 * journal-backed feature: a command reads through `repos.withTx(tx)` with the
 * `tx` the journal hands it, then writes its events with `write`.
 *
 * The one setup rule this pins: create the journal with
 * `initJournal.tx<Transaction>()`, so `tx` has the app's own Drizzle
 * transaction type. With plain `initJournal({ tables, meta })`, `tx` is the journal's
 * structural `DbHandle`, which the repository factories do not accept.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { DepsOf } from '@arki/dot/feature';
import { TransactionDefect } from '@arki/db/transaction';
import { repos } from '@arki/db/dot';
import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { plugin } from '@arki/dot/plugin';
import { orThrow } from '@arki/failure';

import { initJournal } from './journal.js';
import { journalTables } from './pg.js';
import { openJournalDb } from './testing.js';

type AccountId = `acc_${string}`;
const accounts = pgTable('accounts', {
  id: varchar('id', { length: 256 }).primaryKey().$type<AccountId>(),
  balance: integer('balance').notNull(),
  version: integer('version').notNull().default(0),
});
const tables = journalTables();

type Db = PgliteDatabase;
/** The app's transaction type, read off Drizzle — what a real app exports from `db.ts`. */
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type Database = Db | Transaction;

class AccountRepository {
  constructor(private readonly db: Database) {}
  async balance(id: AccountId): Promise<number | null> {
    const [row] = await this.db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, id));
    return row?.balance ?? null;
  }
}

// The fix that makes the two fit: the journal's `tx` is the app's `Transaction`.
const j = initJournal.tx<Transaction>().create({ tables, meta: z.object({ actorId: z.string().min(1) }) });
const Opened = j.event('Opened', z.object({ balance: z.int().nonnegative() }));
const Deposited = j.event('Deposited', z.object({ amount: z.int().positive() }));
const account = j
  .entity('account', accounts)
  .create(Opened, e => ({ balance: e.data.balance }))
  .on(Deposited, (row, e) => ({ balance: row.balance + e.data.amount }));
const journal = j.compose({});

let handle: Db;
let client: PGlite;
const database = plugin({ name: 'database', provides: { db: (): Db => handle } });

const repository = repos({ accounts: (d: Database) => new AccountRepository(d) });

const accountsBase = defineFeature('accounts').needs({ db: database.provides.db }).infra(repository);
type Deps = DepsOf<typeof accountsBase>;

/** Open an account, then read it back through the repositories — inside the same transaction. */
const open = ({ repos }: Deps) => {
  const command = j.command(
    'open',
    z.object({ id: z.templateLiteral(['acc_', z.string()]), balance: z.int().nonnegative(), fail: z.boolean() }),
    async (input, { write, tx }) => {
      expectTypeOf(tx).toEqualTypeOf<Transaction>();
      orThrow(await write(account, input.id, () => [Opened({ balance: input.balance })]));
      const seen = await repos.withTx(tx).accounts.balance(input.id);
      if (input.fail) throw new Error('rolled back after the read');
      return seen;
    },
  );
  return (id: AccountId, balance: number, fail = false) =>
    journal.run(handle, command, { id, balance, fail }, { actorId: 'usr_test' });
};
const balance =
  ({ repos }: Deps) =>
  (id: AccountId) =>
    repos.accounts.balance(id);

const accountsFeature = accountsBase.usecases({ open, balance }).entrypoints();

beforeAll(async () => {
  ({ db: handle, client } = await openJournalDb({ ...tables, accounts }));
});

afterAll(async () => {
  await client.close();
});

describe('repos() in a journal command', () => {
  it('reads through withTx(tx) see the command’s own writes, before the commit', async () => {
    const app = await orThrow(defineApp('ledger').infra(database).features([accountsFeature]).start());
    try {
      expect(await app.services['accounts.usecases'].open('acc_1', 10)).toBe(10);
      expect(await app.services['accounts.usecases'].balance('acc_1')).toBe(10);
    } finally {
      await orThrow(app.dispose());
    }
  });

  it('a command that throws takes its writes with it; the repositories see nothing after', async () => {
    const app = await orThrow(defineApp('ledger').infra(database).features([accountsFeature]).start());
    try {
      await expect(app.services['accounts.usecases'].open('acc_2', 5, true)).resolves.toMatchObject({
        code: TransactionDefect.code,
        cause: new Error('rolled back after the read'),
      });
      expect(await app.services['accounts.usecases'].balance('acc_2')).toBeNull();
    } finally {
      await orThrow(app.dispose());
    }
  });

  it('without initJournal.tx<Transaction>(), tx is the structural DbHandle and does not fit', () => {
    const plain = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
    // Defined, never run: the check is the compiler's.
    plain.command('peek', z.object({}), (_input, { tx }) => {
      expectTypeOf(tx).not.toExtend<Database>();
    });
  });
});
