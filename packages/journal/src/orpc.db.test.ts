/**
 * A journal command inside a transactional procedure, and the receipt recipe
 * for an ambiguous commit.
 *
 * Why these tests exist: the middleware never retries an unknown commit
 * outcome (a lost connection or a lost response), because the commit may have
 * happened. The recovery is the client repeating the request with the same
 * idempotency key, and the journal replaying the receipt the first run
 * committed. That only works if the command's events, jobs and receipt share
 * the outer transaction's fate, if a rolled-back attempt leaves nothing behind,
 * and if the key is scoped so one caller can never replay another's result.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { oc } from '@orpc/contract';
import { call, implement } from '@orpc/server';
import { count, eq } from 'drizzle-orm';
import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { TransactionalDb } from '@arki/db/transaction';
import { transactionalProcedure, transactionalProcedureConfig } from '@arki/db/orpc';
import { errorMap, orThrowRpc } from '@arki/failure/orpc';

import { CommandForbidden, initJournal } from './index.js';
import { commandErrors } from './orpc.js';
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
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

const j = initJournal.tx<Transaction>().create({ tables, meta: z.object({ actorId: z.string().min(1) }) });
const Opened = j.event('Opened', z.object({ balance: z.int().nonnegative() }));
const Deposited = j.event('Deposited', z.object({ amount: z.int().positive() }));
const account = j
  .entity('account', accounts)
  .create(Opened, e => ({ balance: e.data.balance }))
  .on(Deposited, (row, e) => ({ balance: row.balance + e.data.amount }));
/** Runs after commit, from a job row: proves a rolled-back attempt leaves no job. */
const notify = j.effect('notify-deposit', account, { Deposited: () => Promise.resolve() });
const journal = j.compose({ effects: [notify] });

const accountIdSchema = z.templateLiteral(['acc_', z.string()]);
let runs = 0;
const revoked = new Set<string>();
const deposit = j.command(
  'deposit',
  z.object({ id: accountIdSchema, amount: z.int().positive() }),
  async (input, { write }) => {
    runs += 1;
    const { row } = await write(account, input.id, row =>
      row ? [Deposited({ amount: input.amount })] : [Opened({ balance: input.amount })],
    );
    return { balance: row?.balance ?? 0 };
  },
  {
    // A replay is authorized like a first run: a receipt proves the command ran, not that this caller may see it.
    authorize: (_input, { meta }) =>
      revoked.has(meta.actorId) ? CommandForbidden({ detail: 'Not allowed to deposit' }) : undefined,
  },
);

/**
 * The receipt key: tenant, actor, operation and version around the client's key.
 * The client part is validated; the composed key must fit `journal_receipts.key` (256).
 */
const clientKey = z.string().regex(/^[\w-]{8,64}$/);
function receiptKey(scope: { tenantId: string; actorId: string }, key: string): string {
  const composed = `${scope.tenantId}:${scope.actorId}:accounts.deposit:v1:${clientKey.parse(key)}`;
  if (composed.length > 256) throw new Error('receipt key longer than 256 characters');
  return composed;
}

type RequestContext = { readonly tenantId: string; readonly actorId: string };

const contract = {
  deposit: oc
    .input(z.object({ id: accountIdSchema, amount: z.int().positive(), key: z.string() }))
    .output(z.object({ balance: z.number() }))
    .errors(errorMap(CommandForbidden)),
};

let client: PGlite;
let db: Db;

function depositProcedure(root: TransactionalDb<Transaction>, afterRun?: (attempt: number) => void) {
  let attempt = 0;
  const transact = transactionalProcedure(root, { repos: () => ({ withTx: (tx: Transaction) => ({ tx }) }) });
  // Order from the integration guide: the journal's error mapping, then `transact` last.
  return implement(contract, transactionalProcedureConfig)
    .$context<RequestContext>()
    .deposit.use(commandErrors())
    .use(transact)
    .handler(async ({ context, input, errors }) => {
      attempt += 1;
      const result = await orThrowRpc(
        journal.run(
          context.tx,
          deposit,
          { id: input.id, amount: input.amount },
          { actorId: context.actorId },
          { idempotencyKey: receiptKey(context, input.key) },
        ),
        errors,
      );
      afterRun?.(attempt);
      return result;
    });
}

/** The real database, but every transaction's response is lost after a real COMMIT. */
function lostAcknowledgment(): TransactionalDb<Transaction> {
  return {
    async transaction(fn, config) {
      await db.transaction(fn, config);
      throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    },
  };
}

/** The real database, but the first transaction fails with 40001 after its work ran (so it rolls back). */
function conflictOnce(): TransactionalDb<Transaction> {
  let failed = false;
  return {
    transaction: (fn, config) =>
      db.transaction(async tx => {
        const result = await fn(tx);
        if (!failed) {
          failed = true;
          throw Object.assign(new Error('could not serialize access'), { code: '40001' });
        }
        return result;
      }, config),
  };
}

const alice = { tenantId: 'org_1', actorId: 'usr_alice' } as const;
let nextId = 0;
const freshAccount = (): AccountId => `acc_${String(++nextId)}`;

async function rowsFor(id: AccountId) {
  const [events] = await db.select({ n: count() }).from(tables.events).where(eq(tables.events.entityId, id));
  const [jobs] = await db.select({ n: count() }).from(tables.jobs).where(eq(tables.jobs.effect, 'notify-deposit'));
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
  return { events: events?.n ?? 0, jobs: jobs?.n ?? 0, balance: row?.balance ?? null };
}

beforeAll(async () => {
  ({ db, client } = await openJournalDb({ ...tables, accounts }));
});

afterAll(async () => {
  await client.close();
});

describe('a journal command inside transact', () => {
  it('shares the outer outcome: a rolled-back attempt leaves no event, job or receipt; the retry writes once', async () => {
    runs = 0;
    const id = freshAccount();
    await call(depositProcedure(db), { id, amount: 10, key: 'open-key-1' }, { context: alice });
    const { jobs: jobsBefore } = await rowsFor(id);

    runs = 0;
    const procedure = depositProcedure(conflictOnce());
    expect(await call(procedure, { id, amount: 5, key: 'retry-key-1' }, { context: alice })).toEqual({ balance: 15 });
    expect(runs).toBe(2);
    const after = await rowsFor(id);
    expect(after.events).toBe(2);
    expect(after.jobs - jobsBefore).toBe(1);
    expect(after.balance).toBe(15);
  });

  it('a proven rollback lets the same key run fresh', async () => {
    runs = 0;
    const id = freshAccount();
    const failing = depositProcedure(db, () => {
      throw new Error('handler failed after the command');
    });
    await expect(call(failing, { id, amount: 3, key: 'rolled-back-1' }, { context: alice })).rejects.toThrow();
    expect(await rowsFor(id)).toMatchObject({ events: 0, balance: null });

    expect(await call(depositProcedure(db), { id, amount: 3, key: 'rolled-back-1' }, { context: alice })).toEqual({
      balance: 3,
    });
    expect(runs).toBe(2);
    expect(await rowsFor(id)).toMatchObject({ events: 1 });
  });
});

describe('ambiguous commit: recovered by the receipt, never by a blind retry', () => {
  it('a lost acknowledgment after a real commit is not retried; the same key replays the receipt, no duplicate writes', async () => {
    runs = 0;
    const id = freshAccount();
    const error = await call(
      depositProcedure(lostAcknowledgment()),
      { id, amount: 7, key: 'lost-ack-01' },
      { context: alice },
    ).catch((error_: unknown) => error_);
    expect(error).toMatchObject({ code: 'ECONNRESET' });
    expect(runs).toBe(1);

    // The client repeats the same logical action with the same key.
    expect(await call(depositProcedure(db), { id, amount: 7, key: 'lost-ack-01' }, { context: alice })).toEqual({
      balance: 7,
    });
    expect(runs).toBe(1);
    expect(await rowsFor(id)).toMatchObject({ events: 1, balance: 7 });
  });

  it('two simultaneous requests with one key: one runs, the other replays', async () => {
    runs = 0;
    const id = freshAccount();
    const procedure = depositProcedure(db);
    const results = await Promise.all([
      call(procedure, { id, amount: 4, key: 'twin-key-01' }, { context: alice }),
      call(procedure, { id, amount: 4, key: 'twin-key-01' }, { context: alice }),
    ]);
    expect(results).toEqual([{ balance: 4 }, { balance: 4 }]);
    expect(runs).toBe(1);
    expect(await rowsFor(id)).toMatchObject({ events: 1 });
  });

  it('the same key with another input is a 409 CONFLICT, through the journal mapping', async () => {
    const id = freshAccount();
    const procedure = depositProcedure(db);
    await call(procedure, { id, amount: 1, key: 'reused-key-1' }, { context: alice });
    await expect(call(procedure, { id, amount: 2, key: 'reused-key-1' }, { context: alice })).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
  });

  it('the same raw key from another tenant or actor does not replay: the key is scoped', async () => {
    runs = 0;
    const id = freshAccount();
    const procedure = depositProcedure(db);
    await call(procedure, { id, amount: 2, key: 'shared-raw-1' }, { context: alice });
    await call(procedure, { id, amount: 2, key: 'shared-raw-1' }, { context: { ...alice, actorId: 'usr_bob' } });
    await call(procedure, { id, amount: 2, key: 'shared-raw-1' }, { context: { ...alice, tenantId: 'org_2' } });
    expect(runs).toBe(3);
    expect(await rowsFor(id)).toMatchObject({ balance: 6 });
  });

  it('authorization revoked between the call and the replay: the replay is refused with a 403', async () => {
    const id = freshAccount();
    const carol = { tenantId: 'org_1', actorId: 'usr_carol' };
    const procedure = depositProcedure(db);
    await call(procedure, { id, amount: 9, key: 'revoke-key-1' }, { context: carol });
    revoked.add(carol.actorId);
    await expect(call(procedure, { id, amount: 9, key: 'revoke-key-1' }, { context: carol })).rejects.toMatchObject({
      code: 'journal.forbidden',
      status: 403,
      defined: true,
    });
  });

  it('refuses a malformed client key before anything runs', async () => {
    runs = 0;
    await expect(
      call(depositProcedure(db), { id: freshAccount(), amount: 1, key: 'no spaces allowed' }, { context: alice }),
    ).rejects.toThrow();
    expect(runs).toBe(0);
  });
});
