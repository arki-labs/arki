/**
 * `transactionalProcedure` on PGlite, through oRPC's own executor.
 *
 * Why these tests exist: the middleware promises that a procedure's writes
 * commit or roll back together, that a bad output rolls back, that only a
 * database conflict reruns the handler (the input is not parsed again), and
 * that a broken pipeline fails loud instead of quietly committing outside the
 * transaction. PGlite has one connection, so conflicts are scripted here; real
 * ones are in `transaction.pg.test.ts`.
 */
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { eventIterator, oc } from '@orpc/contract';
import { call, implement, ORPCError, os } from '@orpc/server';
import { eq, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { RandomSourceUnavailable } from '@arki/contracts';
import { defineFailure, isFailure, orThrow } from '@arki/failure';

import type { TransactionalDb } from './composition.js';
import { transactionalProcedure, transactionalProcedureConfig, transactionErrorMap } from './orpc.js';
import { DB_TRANSACTION_ERROR_CODES, TransactionConflict } from './transaction.js';

const accounts = pgTable('accounts', { id: text('id').primaryKey(), balance: integer('balance').notNull() });

type Db = PgliteDatabase;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Database = Db | Tx;

function accountRepository(db: Database) {
  return {
    async balance(id: string): Promise<number | null> {
      const [row] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, id));
      return row?.balance ?? null;
    },
    async add(id: string, cents: number): Promise<void> {
      await db
        .update(accounts)
        .set({ balance: sql`${accounts.balance} + ${cents}` })
        .where(eq(accounts.id, id));
    },
  };
}

const client = new PGlite();
const db = drizzle({ client });

/** What `repos()` from `@arki/db/dot` publishes, minus the pool-bound set. Counts `withTx` calls. */
const bound: object[] = [];
const repositories = {
  withTx(tx: Database) {
    const set = { accounts: accountRepository(tx) };
    bound.push(set);
    return set;
  },
};

let parses = 0;
const transferInput = z.object({ from: z.string(), to: z.string(), cents: z.int().positive() }).transform(value => {
  parses += 1;
  return value;
});

const base = oc.errors(transactionErrorMap);
const contract = {
  transfer: base.input(transferInput).output(z.object({ from: z.number(), to: z.number() })),
  isolation: base.output(z.string()),
  capped: base.output(z.object({ n: z.number().max(10) })),
  stream: base.output(eventIterator(z.number())),
};

const sqlError = (code: string): Error => Object.assign(new Error(`sqlstate ${code}`), { code });

/** The real database, but the first `failFirst` transactions throw `40001` after the work ran (so they roll back). */
function flaky(failFirst: number) {
  let calls = 0;
  const wrapped: TransactionalDb<Tx> = {
    transaction: (fn, config) =>
      db.transaction(async tx => {
        const result = await fn(tx);
        calls += 1;
        if (calls <= failFirst) throw sqlError('40001');
        return result;
      }, config),
  };
  return { db: wrapped, calls: () => calls };
}

const impl = implement(contract, transactionalProcedureConfig);
let runs = 0;

function transferProcedure(root: TransactionalDb<Tx>, retries = 3) {
  const transact = transactionalProcedure(root, { repos: () => repositories, retries });
  return impl.transfer.use(transact).handler(async ({ context: { repos }, input }) => {
    runs += 1;
    expectTypeOf(repos).toEqualTypeOf<{ accounts: ReturnType<typeof accountRepository> }>();
    await repos.accounts.add(input.from, -input.cents);
    await repos.accounts.add(input.to, input.cents);
    return { from: (await repos.accounts.balance(input.from)) ?? 0, to: (await repos.accounts.balance(input.to)) ?? 0 };
  });
}

const balanceOf = async (id: string) => accountRepository(db).balance(id);

beforeAll(async () => {
  await db.execute(sql`create table accounts (id text primary key, balance int not null)`);
});

beforeEach(async () => {
  runs = 0;
  parses = 0;
  bound.length = 0;
  await db.execute(sql`delete from accounts`);
  await db.insert(accounts).values([
    { id: 'a', balance: 100 },
    { id: 'b', balance: 100 },
  ]);
});

afterAll(async () => {
  await client.close();
});

describe('transactionalProcedure: one transaction per call', () => {
  it('runs the handler at SERIALIZABLE', async () => {
    const transact = transactionalProcedure(db, { repos: () => repositories });
    const isolation = impl.isolation.use(transact).handler(async ({ context }) => {
      const result = await context.tx.execute<{ transaction_isolation: string }>(sql`show transaction_isolation`);
      return result.rows[0]?.transaction_isolation ?? 'unknown';
    });
    expect(await call(isolation, {})).toBe('serializable');
  });

  it('commits both writes, and hands the handler repositories bound to tx (no withTx on them)', async () => {
    expect(await call(transferProcedure(db), { from: 'a', to: 'b', cents: 30 })).toEqual({ from: 70, to: 130 });
    expect(bound).toHaveLength(1);
    expect(Object.keys(bound[0] ?? {})).toEqual(['accounts']);
    expect(await balanceOf('b')).toBe(130);
  });

  it('rolls both writes back when the handler throws', async () => {
    const transact = transactionalProcedure(db, { repos: () => repositories });
    const failing = impl.transfer.use(transact).handler(async ({ context: { repos }, input }) => {
      await repos.accounts.add(input.from, -input.cents);
      await repos.accounts.add(input.to, input.cents);
      throw new ORPCError('NOT_FOUND');
    });
    const error = await call(failing, { from: 'a', to: 'b', cents: 30 }).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: 'NOT_FOUND' });
    expect([await balanceOf('a'), await balanceOf('b')]).toEqual([100, 100]);
  });
});

describe('transactionalProcedure: retry', () => {
  it('reruns the whole handler on 40001 with fresh repositories; the input is parsed once', async () => {
    const root = flaky(1);
    expect(await call(transferProcedure(root.db), { from: 'a', to: 'b', cents: 10 })).toEqual({ from: 90, to: 110 });
    expect(runs).toBe(2);
    expect(parses).toBe(1);
    expect(bound).toHaveLength(2);
    expect(bound[0]).not.toBe(bound[1]);
    // The first attempt's writes rolled back: the money moved once.
    expect(await balanceOf('a')).toBe(90);
  });

  it('runs an ORPCError once and hands it to the caller as it is', async () => {
    let attempts = 0;
    const transact = transactionalProcedure(flaky(0).db, { repos: () => repositories });
    const missing = impl.transfer.use(transact).handler(() => {
      attempts += 1;
      throw new ORPCError('NOT_FOUND', { message: 'no such account' });
    });
    await expect(call(missing, { from: 'a', to: 'x', cents: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'no such account',
    });
    expect(attempts).toBe(1);
  });

  it('out of retries: ORPCError CONFLICT, status 409, without the database error as cause', async () => {
    const root = flaky(100);
    const error = await call(transferProcedure(root.db, 1), { from: 'a', to: 'b', cents: 10 }).catch(
      (error_: unknown) => error_,
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: TransactionConflict.code, status: 409, defined: true });
    expect(error instanceof ORPCError ? error.cause : 'not an ORPCError').toBeUndefined();
    expect(runs).toBe(2);
    expect(await balanceOf('a')).toBe(100);
  });

  it('keeps concurrent calls apart: each gets its own transaction and repositories', async () => {
    const transfer = transferProcedure(db);
    await Promise.all(Array.from({ length: 5 }, () => call(transfer, { from: 'a', to: 'b', cents: 1 })));
    expect(new Set(bound).size).toBe(5);
    expect([await balanceOf('a'), await balanceOf('b')]).toEqual([95, 105]);
  });
});

describe('transactionalProcedure: output inside the transaction', () => {
  it('an invalid output rolls back, and the handler ran once', async () => {
    const transact = transactionalProcedure(db, { repos: () => repositories });
    const capped = impl.capped.use(transact).handler(async ({ context: { repos } }) => {
      runs += 1;
      await repos.accounts.add('a', 1);
      return { n: 99 };
    });
    await expect(call(capped, {})).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(runs).toBe(1);
    expect(await balanceOf('a')).toBe(100);
  });

  it('refuses a stream (ARKI_DB_TX_E005) and rolls back: it would be read after the commit', async () => {
    const transact = transactionalProcedure(db, { repos: () => repositories });
    const stream = impl.stream.use(transact).handler(async function* ({ context: { repos } }) {
      await repos.accounts.add('a', 1);
      yield 1;
    });
    await expect(call(stream, {})).rejects.toMatchObject({ code: DB_TRANSACTION_ERROR_CODES.unsupportedOutput });
    expect(await balanceOf('a')).toBe(100);
  });
});

describe('transactionalProcedure: the pipeline is checked, fail closed', () => {
  it('refuses a middleware after it (ARKI_DB_TX_E004): that middleware would rerun on every retry', async () => {
    const transact = transactionalProcedure(db, { repos: () => repositories });
    const late = impl.isolation
      .use(transact)
      .use(({ next }) => next())
      .handler(() => 'x');
    await expect(call(late, {})).rejects.toMatchObject({ code: DB_TRANSACTION_ERROR_CODES.invalidPipeline });
  });

  it('refuses output validated after the commit (no transactionalProcedureConfig): ARKI_DB_TX_E004', async () => {
    const transact = transactionalProcedure(db, { repos: () => repositories });
    const outside = implement(contract)
      .isolation.use(transact)
      .handler(() => 'x');
    await expect(call(outside, {})).rejects.toMatchObject({ code: DB_TRANSACTION_ERROR_CODES.invalidPipeline });
  });

  it('refuses a transactional procedure called from inside another one (ARKI_DB_TX_E003)', async () => {
    const transact = transactionalProcedure(db, { repos: () => repositories });
    const inner = impl.isolation.use(transact).handler(() => 'inner');
    const outer = impl.isolation.use(transact).handler(({ context }) => call(inner, undefined, { context }));
    await expect(call(outer, {})).rejects.toMatchObject({ code: DB_TRANSACTION_ERROR_CODES.nestedTransaction });
  });

  it('refuses bad settings when built, not on the first request (ARKI_DB_TX_E002)', () => {
    expect(() => transactionalProcedure(db, { repos: () => repositories, retries: 11 })).toThrow(
      expect.objectContaining({ code: DB_TRANSACTION_ERROR_CODES.invalidOptions }),
    );
  });
});

const Refused = defineFailure('test.rpc_refused');

it('maps a bridged ID generation failure through the declared native error map after rollback', async () => {
  const failure = RandomSourceUnavailable();
  const transact = transactionalProcedure(db, { repos: () => repositories });
  const procedure = impl.isolation.use(transact).handler(async ({ context }) => {
    await context.tx.insert(accounts).values({ id: 'generation_failed', balance: 7 });
    return orThrow(failure);
  });
  await expect(call(procedure, {})).rejects.toMatchObject({
    code: failure.code,
    status: 500,
    defined: true,
  });
  expect(await balanceOf('generation_failed')).toBeNull();
});

it('classifies next().output and preserves the native result metadata while rolling back', async () => {
  const failure = Refused();
  const transact = transactionalProcedure(db, { repos: () => repositories });
  const procedure = implement(
    base.output(z.custom<ReturnType<typeof Refused>>(isFailure)),
    transactionalProcedureConfig,
  )
    .use(transact)
    .handler(async ({ context }) => {
      await context.tx.insert(accounts).values({ id: 'refused', balance: 7 });
      return failure;
    });
  expect(await call(procedure, {})).toBe(failure);
  expect(await balanceOf('refused')).toBeNull();
});

it('restores the exact native middleware wrapper, including extra metadata', async () => {
  const failure = Refused();
  const transact = transactionalProcedure(db, { repos: () => repositories });
  let expected: object | undefined;
  const observe = os.errors(transactionErrorMap).middleware(async options => {
    const result = await transact({
      ...options,
      next: (...[forward]) => {
        if (forward?.context === undefined) throw new Error('Transaction scope missing');
        const wrapped = { output: failure, context: forward.context, metadata: { receipt: 'kept' } };
        expected = wrapped;
        return Promise.resolve(wrapped);
      },
    });
    expect(result).toBe(expected);
    return result;
  });
  const procedure = implement(
    base.output(z.custom<ReturnType<typeof Refused>>(isFailure)),
    transactionalProcedureConfig,
  )
    .use(observe)
    .use(transact)
    .handler(() => failure);
  expect(await call(procedure, {})).toBe(failure);
});
