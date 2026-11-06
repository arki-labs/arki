/**
 * `IntegrationTester` types that used to take `any`
 *
 * The `expectTypeOf` lines fail to compile if a type goes back to `any`.
 */
import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import { describe, expectTypeOf, it } from 'vitest';

import type { IntegrationTester } from './integration-tester';
import type { IntegrationTesterConfig } from './types';

describe('IntegrationTester surface', () => {
  type AnyTester = IntegrationTester<
    Record<string, unknown>,
    never,
    Record<string, unknown>,
    unknown,
    Record<string, unknown>,
    never
  >;

  it('the current transaction has the app database type, so no cast swaps one for the other', () => {
    type Handle = NodePgDatabase<AnyRelations> | NodePgTransaction<AnyRelations>;
    type Root = NodePgDatabase<AnyRelations>;
    type AppTester = IntegrationTester<
      Record<string, unknown>,
      Root,
      Record<string, unknown>,
      unknown,
      Record<string, unknown>,
      Handle
    >;
    expectTypeOf<AppTester['currentTx']>().toEqualTypeOf<Handle | null>();
    expectTypeOf<AppTester['db']>().toEqualTypeOf<Root>();
  });

  it('createDatabase returns the database type that createRepositories takes', () => {
    type Config = IntegrationTesterConfig<Record<string, never>, never, never, never, never, never>;
    expectTypeOf<Config['createDatabase']>().parameters.toEqualTypeOf<[connectionString: string]>();
  });

  it('withTransaction returns nothing, because the transaction always rolls back', () => {
    expectTypeOf<AnyTester['withTransaction']>().returns.resolves.toBeVoid();
  });

  it('seed takes arrays of objects keyed by table name', () => {
    expectTypeOf<AnyTester['seed']>().parameter(0).toEqualTypeOf<Record<string, readonly object[]>>();
  });
});
