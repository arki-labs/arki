// Cost of a serializable transaction with retry: @arki/db/transaction and @arki/db/orpc
// against bare Drizzle, a hand-written retry loop and p-retry, on one in-memory PGlite.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// PGlite has one connection and never conflicts, so no case takes a retry: the
// numbers are the wrapper's overhead on the success path. Each run moves cents from
// one account to the other and back, inside one transaction, so the balances never
// drift and every case must return the same thing.

import { PGlite } from '@electric-sql/pglite';
import { call, os } from '@orpc/server';
import { eq, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import pRetry from 'p-retry';
import { z } from 'zod';

import { compare, defineSuite } from '@arki/bench';
import { transactionalProcedure, transactionalProcedureConfig } from '@arki/db/orpc';
import { retryableSqlState, runTransaction } from '@arki/db/transaction';

const accounts = pgTable('bench_accounts', { id: text('id').primaryKey(), balance: integer('balance').notNull() });

/** One PGlite for every case. Created on first use, not at import. */
const sharedEnvironment = (() => {
  let pending: ReturnType<typeof createEnvironment> | undefined;
  return () => (pending ??= createEnvironment());
})();

async function createEnvironment() {
  const pglite = new PGlite();
  const db = drizzle({ client: pglite });
  await pglite.exec(`
    create table bench_accounts (id text primary key, balance int not null);
    insert into bench_accounts values ('a', 1000), ('b', 1000);
  `);
  return db;
}

type Db = Awaited<ReturnType<typeof createEnvironment>>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Database = Db | Tx;

/** The work every case runs: move `cents` a → b and back, then read the total. */
async function moveAndBack(db: Database, cents: number): Promise<{ total: number; moved: number }> {
  await db
    .update(accounts)
    .set({ balance: sql`${accounts.balance} - ${cents}` })
    .where(eq(accounts.id, 'a'));
  await db
    .update(accounts)
    .set({ balance: sql`${accounts.balance} + ${cents}` })
    .where(eq(accounts.id, 'b'));
  await db
    .update(accounts)
    .set({ balance: sql`${accounts.balance} + ${cents}` })
    .where(eq(accounts.id, 'a'));
  await db
    .update(accounts)
    .set({ balance: sql`${accounts.balance} - ${cents}` })
    .where(eq(accounts.id, 'b'));
  const [row] = await db.select({ total: sql<number>`sum(${accounts.balance})::int` }).from(accounts);
  return { total: row?.total ?? Number.NaN, moved: cents };
}

const SERIALIZABLE = { isolationLevel: 'serializable' } as const;
const MAX_RETRIES = 3;

/** The loop an app writes by hand without the library: same predicate, same bound. */
async function handWrittenRetry<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(work, SERIALIZABLE);
    } catch (error) {
      if (attempt >= MAX_RETRIES || retryableSqlState(error) === undefined) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, 10 * 2 ** attempt)));
    }
  }
}

/** The procedure, built once per environment: the middleware's own cost includes oRPC's executor. */
const sharedProcedure = (() => {
  let pending: Promise<ReturnType<typeof buildProcedure>> | undefined;
  return () => (pending ??= sharedEnvironment().then(buildProcedure));
})();

function buildProcedure(db: Db) {
  const repositories = { withTx: (tx: Tx) => ({ tx }) };
  return os
    .$config(transactionalProcedureConfig)
    .input(z.object({ cents: z.int() }))
    .use(transactionalProcedure(db, { repos: () => repositories }))
    .handler(({ context, input }) => moveAndBack(context.repos.tx, input.cents));
}

const expected = (cents: number): string => JSON.stringify({ total: 2000, moved: cents });
const normalize = (result: { total: number; moved: number }): string => JSON.stringify(result);

export default defineSuite({
  id: '@arki/db/transaction',
  intro:
    'One serializable transaction with retry on `40001` / `40P01`: `runTransaction` and the `transactionalProcedure` oRPC middleware, against bare Drizzle (no retry), a hand-written retry loop and `p-retry`, all on the same in-memory PGlite.',
  notes: [
    'PGlite never conflicts, so no case retries: this is the overhead of each wrapper on the success path, plus the same four updates and one read.',
    'The `transactionalProcedure` case also pays for oRPC: input parsing, the executor and the pipeline check. Compare it with `runTransaction` to see the middleware alone.',
    'Retry under real contention is proven in `src/transaction.pg.test.ts`, not timed here.',
  ],
  groups: [
    compare<number>({
      id: 'serializable-transaction',
      title: 'Run one serializable transaction (no conflict)',
      contract: {
        id: 'db-serializable-transaction/v1',
        description:
          'cents moved from account a to b and back inside one transaction; returns `{ total: 2000, moved }`, so the balances never drift',
      },
      inputs: [1, 10, 100, 999],
      expected,
      mode: 'async',
      baseline: 'runTransaction',
      cases: c => ({
        runTransaction: c({
          label: '@arki/db runTransaction',
          package: '@arki/db',
          setup: cents => ({ environment: sharedEnvironment(), cents }),
          run: async ({ environment, cents }) => runTransaction(await environment, tx => moveAndBack(tx, cents)),
          normalize,
        }),
        middleware: c({
          label: '@arki/db transactionalProcedure, through oRPC call()',
          package: '@arki/db',
          variant: true,
          setup: cents => ({ procedure: sharedProcedure(), cents }),
          run: async ({ procedure, cents }) => call(await procedure, { cents }),
          normalize,
        }),
        bare: c({
          label: 'bare Drizzle db.transaction (serializable, no retry)',
          package: 'drizzle-orm',
          setup: cents => ({ environment: sharedEnvironment(), cents }),
          run: async ({ environment, cents }) => {
            const db = await environment;
            return db.transaction(tx => moveAndBack(tx, cents), SERIALIZABLE);
          },
          normalize,
        }),
        handLoop: c({
          label: 'hand-written retry loop around db.transaction',
          setup: cents => ({ environment: sharedEnvironment(), cents }),
          run: async ({ environment, cents }) => handWrittenRetry(await environment, tx => moveAndBack(tx, cents)),
          normalize,
        }),
        pRetry: c({
          label: 'p-retry around db.transaction, same predicate and delays',
          package: 'p-retry',
          setup: cents => ({ environment: sharedEnvironment(), cents }),
          run: async ({ environment, cents }) => {
            const db = await environment;
            return pRetry(() => db.transaction(tx => moveAndBack(tx, cents), SERIALIZABLE), {
              retries: MAX_RETRIES,
              minTimeout: 10,
              maxTimeout: 250,
              randomize: true,
              shouldRetry: ({ error }) => retryableSqlState(error) !== undefined,
            });
          },
          normalize,
        }),
      }),
    }),
  ],
});
