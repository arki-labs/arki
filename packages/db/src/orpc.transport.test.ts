/**
 * The same transactional procedure through the two ways `@arki/tanstack-start`
 * serves oRPC: the fetch `RPCHandler` (HTTP) and `createRouterClient` (direct,
 * for SSR loaders).
 *
 * Why these tests exist: both run the middleware chain, but only a test shows
 * they agree. A client must see a rollback the same way, get the 409 on a
 * lost race as an HTTP status, and never receive a success before COMMIT.
 */
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { oc } from '@orpc/contract';
import { createRouterClient, implement } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { TransactionalDb } from './composition.js';
import { transactionalProcedure, transactionalProcedureConfig, transactionErrorMap } from './orpc.js';

type Db = PgliteDatabase;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const client = new PGlite();
const db = drizzle({ client });

/** Holds every transaction after its work, before COMMIT, until `open()`; or fails it with 40001 when `conflict` is set. */
const gate = { open: Promise.resolve(), conflict: false };
const gated: TransactionalDb<Tx> = {
  transaction: (fn, config) =>
    db.transaction(async tx => {
      const result = await fn(tx);
      await gate.open;
      if (gate.conflict) throw Object.assign(new Error('could not serialize access'), { code: '40001' });
      return result;
    }, config),
};

const contract = {
  credit: oc
    .errors(transactionErrorMap)
    .input(z.object({ cents: z.int() }))
    .output(z.object({ balance: z.number() })),
};
const transact = transactionalProcedure(gated, {
  retries: 0,
  repos: () => ({ withTx: (tx: Tx) => ({ tx }) }),
});
const router = {
  credit: implement(contract, transactionalProcedureConfig)
    .credit.use(transact)
    .handler(async ({ context: { repos }, input }) => {
      const result = await repos.tx.execute<{ balance: number }>(
        sql`update ledger set balance = balance + ${input.cents} returning balance`,
      );
      const balance = result.rows[0]?.balance ?? 0;
      if (balance < 0) throw new Error('overdrawn');
      return { balance };
    }),
};

const http = new RPCHandler(router);
const direct = createRouterClient(router);

/** POST one RPC call, as the browser link does: the body and the answer are `{ json }`. */
async function overHttp(cents: number): Promise<{ status: number; body: unknown }> {
  const { response } = await http.handle(
    new Request('http://localhost/rpc/credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { cents } }),
    }),
    { prefix: '/rpc' },
  );
  if (response === undefined) throw new Error('no procedure matched');
  return { status: response.status, body: await response.json() };
}

async function balance(): Promise<number | undefined> {
  const result = await db.execute<{ balance: number }>(sql`select balance from ledger`);
  return result.rows[0]?.balance;
}

/** True once `promise` has settled; checked after a macrotask so pending callbacks ran. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  return settled;
}

beforeAll(async () => {
  await db.execute(sql`create table ledger (balance int not null)`);
});

beforeEach(async () => {
  gate.open = Promise.resolve();
  gate.conflict = false;
  await db.execute(sql`delete from ledger`);
  await db.execute(sql`insert into ledger values (100)`);
});

afterAll(async () => {
  await client.close();
});

describe('HTTP and direct client agree', () => {
  it('commit: both answer with the committed value', async () => {
    expect(await overHttp(5)).toEqual({ status: 200, body: { json: { balance: 105 } } });
    expect(await direct.credit({ cents: 5 })).toEqual({ balance: 110 });
    expect(await balance()).toBe(110);
  });

  it('rollback: both fail, and neither write is kept', async () => {
    // HTTP turns an unknown error into a 500; the direct client hands the server code the error itself.
    expect(await overHttp(-500)).toMatchObject({ status: 500 });
    await expect(direct.credit({ cents: -500 })).rejects.toMatchObject({
      code: 'db.transaction_defect',
      defined: true,
    });
    expect(await balance()).toBe(100);
  });

  it('out of retries: HTTP 409 with code CONFLICT; the direct client throws the same', async () => {
    gate.conflict = true;
    const { status, body } = await overHttp(1);
    expect(status).toBe(409);
    expect(body).toMatchObject({ json: { code: 'db.transaction_conflict', status: 409 } });
    await expect(direct.credit({ cents: 1 })).rejects.toMatchObject({ code: 'db.transaction_conflict', status: 409 });
    expect(await balance()).toBe(100);
  });

  it('commit timing: no answer leaves before COMMIT, on either transport', async () => {
    for (const send of [() => overHttp(1), () => direct.credit({ cents: 1 })]) {
      const commit = Promise.withResolvers<void>();
      gate.open = commit.promise;
      const answer = send();
      expect(await hasSettled(answer)).toBe(false);
      commit.resolve();
      await answer;
    }
    expect(await balance()).toBe(102);
  });
});
