/**
 * `transactions()`: a usecase may open a transaction, but it never holds the
 * database. The plugin is bound to the feature's database handle (`.infra()`
 * refuses any other), and publishes one function, `transaction(fn)`: `fn` runs
 * inside a transaction of that database, committed on return and rolled
 * back on a throw. No query builder and no `db` leave the plugin, so with
 * `db` entrypoint-only a usecase can open a transaction and nothing else.
 * PGlite throughout.
 */
import { defineRelations, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { DepsOf } from '@arki/dot/feature';
import type { Provided } from '@arki/dot/plugin';
import { defineApp } from '@arki/dot';
import { defineFeature, entrypointOnly } from '@arki/dot/feature';
import { plugin, rename } from '@arki/dot/plugin';
import { orThrow, UnexpectedDefect } from '@arki/failure';

import type { OpenTransaction, TxOf } from './dot.js';
import { db, repos, transactions } from './dot.js';

const notes = pgTable('notes', { id: text('id').primaryKey(), body: text('body').notNull() });
const relations = defineRelations({ notes });

const database = db({ driver: 'pglite', memory: true, relations });
type Db = Provided<typeof database.provides.db>;
/** The app's transaction type, read off Drizzle — what a real app exports from `db.ts`. */
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type Database = Db | Transaction;

const createNoteRepository = (handle: Database) => ({
  add: async (id: string, body: string): Promise<void> => {
    await handle.insert(notes).values({ id, body });
  },
  count: async (): Promise<number> => {
    const rows = await handle.select().from(notes);
    return rows.length;
  },
});

const store = repos({ notes: createNoteRepository });
const transactional = transactions(database.provides.db);

/** `db` is entrypoint-only: the usecases open transactions through `transaction` and bind the repos with `withTx(tx)`. */
const ledgerDeps = defineFeature('ledger')
  .needs({ db: entrypointOnly(database.provides.db) })
  .infra(store, transactional);
type Deps = DepsOf<typeof ledgerDeps>;
const ledger = ledgerDeps
  .usecases({
    /** Two writes, one unit: `fail` throws after the first so the test can see it undone. */
    addPair:
      ({ transaction, repos }: Deps) =>
      (first: string, second: string, fail: boolean) =>
        transaction(async tx => {
          const bound = repos.withTx(tx);
          await bound.notes.add(first, 'one');
          if (fail) throw new Error('after the first write');
          await bound.notes.add(second, 'two');
          return bound.notes.count();
        }),
    count:
      ({ repos }: Deps) =>
      () =>
        repos.notes.count(),
  })
  .entrypoints();

async function bootLedger() {
  const app = await orThrow(defineApp('ledger-app').infra(database).features([ledger]).start());
  await app.services.db.execute(sql`create table notes (id text primary key, body text not null)`);
  return app;
}

describe('transactions(): a usecase opens a transaction and nothing else', () => {
  it('needs db unbound and is private to the feature: dot explain draws ledger → ledger/transactions → db', () => {
    const configured = orThrow(defineApp('wiring').infra(database).features([ledger]).configure());
    const byName = new Map(configured.manifest.plugins.map(p => [p.name, p]));
    expect(byName.get('ledger/transactions')?.provides).toEqual(['ledger.transaction']);
    expect(byName.get('ledger/transactions')?.dependencies).toEqual(['db']);
    expect(byName.get('ledger')?.dependencies).toContain('ledger.transaction');
  });

  it('commits on return: both writes are visible afterwards', async () => {
    const app = await bootLedger();
    try {
      const usecases = app.services['ledger.usecases'];
      expect(await usecases.addPair('a', 'b', false)).toBe(2);
      expect(await usecases.count()).toBe(2);
    } finally {
      await orThrow(app.dispose());
    }
  });

  it('rolls back on a throw: the write before the throw is gone too', async () => {
    const app = await bootLedger();
    try {
      const usecases = app.services['ledger.usecases'];
      const failure = await usecases.addPair('a', 'b', true);
      expect(UnexpectedDefect.is(failure)).toBe(true);
      expect(failure).toMatchObject({ cause: new Error('after the first write') });
      expect(await usecases.count()).toBe(0);
    } finally {
      await orThrow(app.dispose());
    }
  });

  it('refuses a feature that lists it without declaring db (the infra-needs rule)', () => {
    // @ts-expect-error a feature with no `db` cannot host the plugin — and the same refusal at runtime
    expect(() => defineFeature('bare').infra(transactional)).toThrow(/needs "db", which the feature does not declare/);
  });

  it('a usecase sees `transaction` but not `db`; the tx it hands out is the database’s own transaction type', () => {
    expectTypeOf<keyof Deps>().toEqualTypeOf<'repos' | 'transaction'>();
    expectTypeOf<Deps['transaction']>().toEqualTypeOf<OpenTransaction<Transaction>>();
    expectTypeOf<Provided<typeof transactional.provides.transaction>>().toEqualTypeOf<OpenTransaction<Transaction>>();
    expectTypeOf<TxOf<Db>>().toEqualTypeOf<Transaction>();
    // The `tx` the handle hands to `fn` is exactly `Transaction`: a repository bound with `withTx(tx)` takes it with no cast.
    expectTypeOf<Parameters<Parameters<Deps['transaction']>[0]>[0]>().toEqualTypeOf<Transaction>();
    // Only `transaction` leaves the plugin: no query builder, no `db`.
    expectTypeOf<keyof Provided<typeof transactional.provides.transaction>>().toEqualTypeOf<never>();
    // @ts-expect-error `db` is entrypoint-only: a usecase cannot hold the database
    ledgerDeps.usecases({
      bad:
        ({ db }: { db: Db }) =>
        () =>
          db,
    });
    const plain = plugin({ name: 'plain', provides: { thing: () => ({ query: () => 0 }) } });
    // @ts-expect-error a handle to a plain object is not a database handle: the service has no `transaction(fn)`
    transactions(plain.provides.thing);
    // Another database's handle (a second instance, renamed as the kernel requires) is refused where the feature binds it.
    const reports = rename(db({ driver: 'pglite', memory: true, relations }), { db: 'reportsDb' }, 'reports-db');
    expect(() =>
      defineFeature('mixed')
        .needs({ db: entrypointOnly(database.provides.db) })
        // @ts-expect-error `transactions` is bound to "reports-db"; this feature's `db` is `database`'s handle
        .infra(transactions(reports.provides.reportsDb)),
    ).toThrow(/binds "db" to a handle other than the feature's/);
  });
});
