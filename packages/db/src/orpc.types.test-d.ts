/**
 * Type tests for `@arki/db/orpc`, checked by `tsc --noEmit` (the package's typecheck).
 *
 * Why these exist: the middleware's whole point is that nothing is restated.
 * `Tx` comes from the database, the repository set from `withTx`, the scope a
 * usecase takes from the middleware. A repository source that cannot take the
 * transaction, or a context that already holds an incompatible `repos`, must
 * fail at compile time, without a cast anywhere.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { oc } from '@orpc/contract';
import { implement } from '@orpc/server';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Repos, RepoSet } from './dot.js';
import type { TransactionContext, TransactionScopeOf } from './orpc.js';
import { transactionalProcedure, transactionalProcedureConfig, transactionErrorMap } from './orpc.js';

type PgDb = NodePgDatabase;
type PgTx = Parameters<Parameters<PgDb['transaction']>[0]>[0];
type LiteDb = PgliteDatabase;
type LiteTx = Parameters<Parameters<LiteDb['transaction']>[0]>[0];

type AccountRepo = { balance(id: string): Promise<number> };
type Factories = { readonly accounts: (db: LiteDb | LiteTx) => AccountRepo };

declare const pgDb: PgDb;
declare const liteDb: LiteDb;
declare const repositories: Repos<Factories>;
/** Exact equality that also holds for Drizzle's transaction (expect-type's deep brand trips on its `rollback(): never`). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

declare const pgRepositories: { withTx(tx: PgDb | PgTx): { readonly accounts: AccountRepo } };

const contract = {
  balance: oc
    .errors(transactionErrorMap)
    .input(z.object({ id: z.string() }))
    .output(z.number())
    .errors({ FROZEN: { status: 423 } }),
  rename: oc
    .errors(transactionErrorMap)
    .input(z.object({ name: z.string() }))
    .output(z.object({ name: z.string() })),
};

describe('inference', () => {
  it('reads Tx off the database: node-postgres and PGlite', () => {
    const onPg = transactionalProcedure(pgDb, { repos: () => pgRepositories });
    expectTypeOf(onPg).toBeFunction();
    expectTypeOf<Equal<TransactionScopeOf<typeof onPg>['tx'], PgTx>>().toEqualTypeOf<true>();
    const onLite = transactionalProcedure(liteDb, { repos: () => repositories });
    expectTypeOf(onLite).toBeFunction();
    expectTypeOf<Equal<TransactionScopeOf<typeof onLite>['tx'], LiteTx>>().toEqualTypeOf<true>();
  });

  it('reads the repository set off withTx: RepoSet<F>, with no withTx of its own', () => {
    const transact = transactionalProcedure(liteDb, { repos: () => repositories });
    expectTypeOf(transact).toBeFunction();
    type Scope = TransactionScopeOf<typeof transact>;
    expectTypeOf<Scope['repos']>().toEqualTypeOf<RepoSet<Factories>>();
    expectTypeOf<Equal<Scope, TransactionContext<LiteTx, RepoSet<Factories>>>>().toEqualTypeOf<true>();
    const useScope = (scope: Scope) => {
      // @ts-expect-error -- the bound set cannot rebind: a usecase never reaches the pool through it
      scope.repos.withTx(scope.tx);
    };
    expectTypeOf(useScope).toBeFunction();
  });

  it('takes the context type from the selector parameter (a Dot feature reads db and repositories off it)', () => {
    type Deps = { readonly db: LiteDb; readonly repositories: Repos<Factories> };
    const transact = transactionalProcedure((ctx: Deps) => ctx.db, { repos: ctx => ctx.repositories });
    expectTypeOf(transact).toBeFunction();
    expectTypeOf<TransactionScopeOf<typeof transact>['repos']>().toEqualTypeOf<RepoSet<Factories>>();
  });
});

describe('refusals at compile time', () => {
  it('refuses factories typed for the pool only: withTx must accept the transaction', () => {
    // What `drizzle({ client })` returns: the database plus its `$client`. A transaction has no client.
    const poolOnly = { withTx: (db: LiteDb & { readonly $client: PGlite }) => ({ accounts: db }) };
    // @ts-expect-error -- `withTx` takes the pool only, so it cannot take the transaction
    const refused = transactionalProcedure(liteDb, { repos: () => poolOnly });
    expectTypeOf(refused).not.toBeNever();
  });

  it('refuses a context that already holds an incompatible `repos` (oRPC IntersectPick, no cast)', () => {
    const transact = transactionalProcedure(liteDb, { repos: () => repositories });
    const impl = implement(contract, transactionalProcedureConfig).$context<{ repos: string }>();
    // @ts-expect-error -- `repos: string` cannot become the bound repository set
    const refused = impl.balance.use(transact);
    expectTypeOf(refused).not.toBeNever();
  });

  it('refuses an isolation level other than serializable', () => {
    // @ts-expect-error -- v1 offers serializable only
    const refused = transactionalProcedure(liteDb, { repos: () => repositories, isolation: 'repeatable read' });
    expectTypeOf(refused).not.toBeNever();
  });
});

describe('the contract survives', () => {
  it('keeps input, output and declared errors; one transact serves procedures with different outputs', () => {
    const transact = transactionalProcedure(liteDb, { repos: () => repositories });
    const impl = implement(contract, transactionalProcedureConfig);
    const balance = impl.balance.use(transact).handler(async ({ context, input, errors }) => {
      expectTypeOf(input).toEqualTypeOf<{ id: string }>();
      expectTypeOf<Equal<typeof context.tx, LiteTx>>().toEqualTypeOf<true>();
      expectTypeOf(context.repos.accounts).toEqualTypeOf<AccountRepo>();
      expectTypeOf(context['~arkiTransaction']).toEqualTypeOf<true>();
      expectTypeOf(errors.FROZEN).toBeFunction();
      return context.repos.accounts.balance(input.id);
    });
    const rename = impl.rename.use(transact).handler(({ input }) => ({ name: input.name }));
    expectTypeOf(balance).not.toBeAny();
    expectTypeOf(rename).not.toBeAny();
  });
});

const transactWithDeclaredFailures = transactionalProcedure(liteDb, { repos: () => repositories });
// @ts-expect-error transaction middleware requires canonical transaction failures in the contract
implement(oc.output(z.number()), transactionalProcedureConfig).use(transactWithDeclaredFailures);
