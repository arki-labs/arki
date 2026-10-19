/**
 * A transactional procedure in a real Dot app: `defineApp`, `defineFeature`,
 * `rename`, `bind`, `rpc`, laid out like an app under `__fixtures__/dot-app/`.
 *
 * Why these tests exist: usecases are built once at boot, so the middleware
 * cannot swap the repositories they captured. The pattern this pins is the
 * one that works: the pool-bound source is renamed `repositories`, and a
 * transaction-aware usecase takes the scope (`{ tx, repos }`) per call. The
 * feature must also keep its layers: procedures call usecases, and the lint
 * that enforces that must stay green.
 */
import { fileURLToPath } from 'node:url';
import { createRouterClient, implement } from '@orpc/server';
import { sql } from 'drizzle-orm';
import { ESLint } from 'eslint';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import type { ServicesBag } from '@arki/dot/feature';
import { defineApp } from '@arki/dot';
import { routerFor } from '@arki/dot/feature';
import { orThrow } from '@arki/failure';

import type { RequestContext } from './__fixtures__/dot-app/src/core/orpc.js';
import type { AccountsTx } from './__fixtures__/dot-app/src/features/accounts/feature.js';
import type { transfer } from './__fixtures__/dot-app/src/features/accounts/usecases/transfer.js';
import type { RepoSet } from './dot.js';
import { client, database, handle } from './__fixtures__/dot-app/src/core/database.js';
import { accounts } from './__fixtures__/dot-app/src/features/accounts/feature.js';
import { accounts as accountsTable } from './__fixtures__/dot-app/src/features/accounts/model/tables.js';

const rpcContract = { accounts: accounts.contract };
const appRouter = implement(rpcContract)
  .$context<RequestContext>()
  .router(routerFor(rpcContract, [accounts]));
const clientFor = (services: ServicesBag) =>
  createRouterClient(appRouter, { context: { session: null, headers: new Headers(), services } });

const start = () => defineApp('ledger').infra(database).features([accounts]).start();

beforeAll(async () => {
  await handle.execute(sql`create table accounts (id text primary key, balance int not null)`);
});

beforeEach(async () => {
  await handle.delete(accountsTable);
  await handle.insert(accountsTable).values([
    { id: 'a', balance: 100 },
    { id: 'b', balance: 100 },
  ]);
});

afterAll(async () => {
  await client.close();
});

describe('transactionalProcedure in a Dot feature', () => {
  it('commits a transfer; the usecase reads its own writes through the bound repos', async () => {
    const app = await orThrow(start());
    try {
      const rpc = clientFor(app.services);
      expect(await rpc.accounts.transfer({ from: 'a', to: 'b', cents: 30 })).toEqual({ from: 70, to: 130 });
      expect(await rpc.accounts.balance({ id: 'b' })).toBe(130);
    } finally {
      await orThrow(app.dispose());
    }
  });

  it('rolls back a failed transfer; the boot-bound repositories still read the pool, untouched', async () => {
    const app = await orThrow(start());
    try {
      const rpc = clientFor(app.services);
      await expect(rpc.accounts.transfer({ from: 'a', to: 'b', cents: 500 })).rejects.toBeDefined();
      expect(await rpc.accounts.balance({ id: 'a' })).toBe(100);
      expect(await app.services['accounts.usecases'].balance('b')).toBe(100);
    } finally {
      await orThrow(app.dispose());
    }
  });

  it('infers the usecase scope from transact, marker included, through the rpc factories', () => {
    type Scope = Parameters<typeof transfer>[0];
    expectTypeOf<Scope>().toEqualTypeOf<AccountsTx>();
    expectTypeOf<Scope['~arkiTransaction']>().toEqualTypeOf<true>();
    expectTypeOf<keyof Scope['repos']>().toEqualTypeOf<'accounts'>();
    expectTypeOf<Scope['repos']>().not.toHaveProperty('withTx');
    expectTypeOf<Scope['repos']>().toExtend<RepoSet<{ readonly accounts: (db: never) => object }>>();
  });

  it('keeps the feature layers green: the procedure calls a usecase and never reads context.repos', async () => {
    const eslint = new ESLint({ cwd: fileURLToPath(new URL('__fixtures__/dot-app', import.meta.url)) });
    const results = await eslint.lintFiles(['src/**/*.ts']);
    expect(results.length).toBeGreaterThan(5);
    expect(results.flatMap(result => result.messages.map(m => `${result.filePath}: ${m.message}`))).toEqual([]);
  });
});
