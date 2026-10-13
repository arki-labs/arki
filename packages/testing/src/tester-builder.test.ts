/**
 * initTester type inference
 *
 * The point of the builder is that an app test gets its own database and
 * repository types on `tester.db` and `tester.repo` without writing type
 * arguments. These tests fail to compile if either falls back to `any`.
 */
import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { createUserId } from '@arki/auth';

import type { TestUser } from './types';
import { initTester } from './tester-builder';

const testUser: TestUser = { id: createUserId(), email: 'test@example.com', name: 'Test' };

type AppDb = NodePgDatabase<AnyRelations>;
type AppContext = { db: AppDb; label: string };
type Caller = { ping(): string };

const widgets = { id: 'widgets' };

function createRepositories(_db: AppDb) {
  return { widgets: { count: (): Promise<number> => Promise.resolve(1) } };
}

const t = initTester
  .context<AppContext>()
  .caller<Caller>()
  .create({
    schema: { widgets },
    migrationsFolder: '',
    createRepositories,
    createContext: ({ db }) => ({ db, label: 'test' }),
    createCaller: () => ({ ping: () => 'pong' }),
    defaultUsers: { user: testUser, moderator: testUser, admin: testUser },
  });

// Built, never set up: only the types are read, so no database is touched.
const basic = t.tester.create();
type Basic = typeof basic;
const factories = { widget: { make: () => ({ id: 1 }) } };
const withFactories = t.tester.withFactories(factories)();
type WithFactories = typeof withFactories;

describe('initTester inference', () => {
  it('infers db and repo from the functions the app passes in', () => {
    expectTypeOf<Basic['db']>().toEqualTypeOf<AppDb>();
    expectTypeOf<Basic['repo']>().toEqualTypeOf<ReturnType<typeof createRepositories>>();
    expectTypeOf<Basic['repo']['widgets']['count']>().returns.resolves.toEqualTypeOf<number>();
    expectTypeOf<Basic['db']>().not.toBeAny();
    expectTypeOf<Basic['repo']>().not.toBeAny();
    expect(basic).toBeDefined();
  });

  it('keeps the same types when factories are injected', () => {
    expectTypeOf<WithFactories['db']>().toEqualTypeOf<AppDb>();
    expectTypeOf<WithFactories['repo']>().toEqualTypeOf<ReturnType<typeof createRepositories>>();
    expectTypeOf<WithFactories['factory']>().toEqualTypeOf<typeof factories>();
    expect(withFactories).toBeDefined();
  });

  it('rejects a repo member that the app never defined', () => {
    expectTypeOf<Basic['repo']>().not.toHaveProperty('gadgets');
  });
});
