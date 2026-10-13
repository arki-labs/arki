/**
 * Helpers that used to take `any`
 *
 * Each helper now has a precise type and checks its input at runtime instead of
 * trusting it. The `expectTypeOf` lines fail to compile if a type goes back to
 * `any`; the runtime lines pin the behaviour the new checks must keep.
 */
import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Factory, FactoryBuilder, FactoryMap } from './factories';
import type { IntegrationTester } from './integration-tester';
import type { IntegrationTesterConfig } from './types';
import {
  assertArraySorted,
  assertContainsId,
  assertDeepPartialMatch,
  assertErrorThrown,
  assertNotContainsId,
  assertPaginationValid,
} from './assertions';
import { getGlobalPostgresConnectionString, getGlobalRedisConnectionString } from './containers';
import { createDebugContext, logDebug, logQuery, logState } from './debug';
import { createFactory, createSequence, FactoryRegistry } from './factories';

type Game = { id: string; name: string; rank: number };
const games: Game[] = [
  { id: 'g1', name: 'Chess', rank: 1 },
  { id: 'g2', name: 'Go', rank: 2 },
];

describe('assertContainsId', () => {
  it('finds an id in the default id field and in a named field', () => {
    expect(() => assertContainsId(games, 'g1')).not.toThrow();
    expect(() => assertContainsId(games, 'Go', 'name')).not.toThrow();
    expect(() => assertContainsId(games, 'g9')).toThrow(/found: \[g1, g2\]/);
  });

  it('refuses at compile time an item type with no id and no field name', () => {
    // @ts-expect-error `{ slug }` has no `id`, so the field name is required
    expect(() => assertContainsId([{ slug: 'a' }], 'a')).toThrow();
    expect(() => assertContainsId([{ slug: 'a' }], 'a', 'slug')).not.toThrow();
    // @ts-expect-error `missing` is not a key of Game
    expect(() => assertContainsId(games, 'g1', 'missing')).toThrow();
  });

  it('assertNotContainsId is the mirror image', () => {
    expect(() => assertNotContainsId(games, 'g9')).not.toThrow();
    expect(() => assertNotContainsId(games, 'g1')).toThrow(/NOT contain/);
  });
});

describe('assertArraySorted', () => {
  it('checks numbers, strings and dates in both orders', () => {
    expect(() => assertArraySorted(games, 'rank')).not.toThrow();
    expect(() => assertArraySorted(games, 'rank', 'desc')).toThrow(/descending/);
    expect(() => assertArraySorted(games, 'name')).not.toThrow();
    const dated = [{ at: new Date(1) }, { at: new Date(2) }];
    expect(() => assertArraySorted(dated, 'at')).not.toThrow();
    expect(() => assertArraySorted(dated.toReversed(), 'at')).toThrow(/ascending/);
  });

  it('fails loudly on values it cannot order, instead of passing silently', () => {
    expect(() => assertArraySorted([{ a: 1 }, { a: null }], 'a')).toThrow(/Cannot compare values of 'a'/);
  });
});

describe('assertDeepPartialMatch', () => {
  it('matches a nested subset of unknown input', () => {
    const actual: unknown = { name: 'Chess', meta: { level: 'hard', extra: 1 } };
    expect(() => assertDeepPartialMatch(actual, { meta: { level: 'hard' } })).not.toThrow();
    expect(() => assertDeepPartialMatch(actual, { meta: { level: 'easy' } })).toThrow(/meta\.level to be "easy"/);
    expect(() => assertDeepPartialMatch(actual, { missing: 1 })).toThrow(/property 'missing'/);
  });

  it('reports a missing property when the actual value is not an object', () => {
    expect(() => assertDeepPartialMatch(null, { a: 1 })).toThrow(/property 'a'/);
    expect(() => assertDeepPartialMatch('text', { a: 1 })).toThrow(/property 'a'/);
  });

  it('checks null explicitly', () => {
    expect(() => assertDeepPartialMatch({ a: 1 }, { a: null })).toThrow(/to be null, got 1/);
  });
});

describe('assertPaginationValid', () => {
  it('narrows an unknown response and checks counts', () => {
    const response: unknown = { items: [1, 2], total: 2, hasMore: false };
    assertPaginationValid(response, { itemsCount: 2, total: 2, hasMore: false });
    expectTypeOf(response.items).toEqualTypeOf<unknown[]>();
    expect(() => assertPaginationValid(response, { total: 3 })).toThrow(/total to be 3, got 2/);
    expect(() => assertPaginationValid({ items: [] }, { total: 0 })).toThrow(/number, got undefined/);
    expect(() => assertPaginationValid({ items: [] }, { hasMore: true })).toThrow(/hasMore to be true, got undefined/);
    expect(() => assertPaginationValid({})).toThrow(/items array/);
  });
});

describe('assertErrorThrown', () => {
  it('returns the Error, and wraps a thrown non-Error in one', async () => {
    const error = await assertErrorThrown(() => Promise.reject(new Error('nope')), 'nope');
    expectTypeOf(error).toEqualTypeOf<Error>();
    // A non-Error rejection is the case under test, so the lint rule is switched off for this line.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const wrapped = await assertErrorThrown(() => Promise.reject('plain text'), /plain text/);
    expect(wrapped).toBeInstanceOf(Error);
  });
});

describe('factories', () => {
  const gameFactory = createFactory<Game>(() => ({ id: 'g', name: 'Game', rank: 0 }));

  it('returns a typed factory, with no cast', () => {
    expectTypeOf(gameFactory).toEqualTypeOf<Factory<Game>>();
    expect(gameFactory({ name: 'Go' }).name).toBe('Go');
  });

  it('createSequence sets one field per value', () => {
    const sequence = createSequence(gameFactory, 'rank', [1, 2, 3], { name: 'Seq' });
    expect(sequence.map(game => game.rank)).toEqual([1, 2, 3]);
    expect(sequence.every(game => game.name === 'Seq')).toBe(true);
  });

  it('factory() is the builder and factory(overrides) is the object, as at runtime', () => {
    expectTypeOf(gameFactory()).toEqualTypeOf<FactoryBuilder<Game>>();
    expectTypeOf(gameFactory({ name: 'Go' })).toEqualTypeOf<Game>();
    // eslint-disable-next-line unicorn/no-useless-undefined -- `undefined` selects the object overload, which is the point
    expectTypeOf(gameFactory(undefined)).toEqualTypeOf<Game>();
    expectTypeOf<ReturnType<Factory<Game>>>().toEqualTypeOf<Game>();
    expect(gameFactory().with('rank', 7).build().rank).toBe(7);
    // eslint-disable-next-line unicorn/no-useless-undefined -- same overload as above, at runtime
    expect(gameFactory(undefined).rank).toBe(0);
  });

  describe('FactoryRegistry', () => {
    type Player = { id: string; score: number };
    const playerFactory = createFactory<Player>(() => ({ id: 'p', score: 0 }));
    const registry = new FactoryRegistry({ game: gameFactory, player: playerFactory });

    const narrowed = (name: string) => {
      if (registry.has(name)) {
        expectTypeOf(name).toEqualTypeOf<'game' | 'player'>();
      }
      return registry.has(name);
    };

    /** Compiled, never called: each line must fail to type-check. */
    const neverRun = () => {
      // @ts-expect-error 'missing' is not a registered name
      registry.create('missing');
      // @ts-expect-error a player has no `name`
      registry.create('player', { name: 'x' });
      // @ts-expect-error a game's rank is a number
      registry.create('game', { rank: 'first' });
    };

    it('infers the output of each name from the map', () => {
      expectTypeOf(registry).toEqualTypeOf<FactoryRegistry<{ game: Game; player: Player }>>();
      expectTypeOf(registry.create('game')).toEqualTypeOf<Game>();
      expectTypeOf(registry.create('player', { score: 3 })).toEqualTypeOf<Player>();
      expectTypeOf(registry.createMany('player', 2)).toEqualTypeOf<Player[]>();
      expectTypeOf(registry.get('game')).toEqualTypeOf<Factory<Game>>();
      expectTypeOf<FactoryMap<{ game: Game }>>().toEqualTypeOf<{ game: Factory<Game> }>();
      expect(registry.create('game', { name: 'Go' }).name).toBe('Go');
      expect(registry.createMany('game', 2)).toHaveLength(2);
    });

    it('rejects names and overrides the map does not have', () => {
      expect(neverRun).toBeTypeOf('function');
    });

    it('has() narrows a string to a registered name', () => {
      expect(narrowed('game')).toBe(true);
      expect(narrowed('toString')).toBe(false);
    });
  });
});

describe('debug and containers', () => {
  it('take unknown, not any', () => {
    expectTypeOf(logDebug).parameters.toEqualTypeOf<[message: string, ...args: unknown[]]>();
    expectTypeOf(logState).parameter(1).toBeUnknown();
    expectTypeOf(logQuery).parameter(1).toEqualTypeOf<readonly unknown[] | undefined>();
    expectTypeOf(createDebugContext('x').state).parameter(1).toBeUnknown();
  });

  it('read the shared connection strings only when they are strings', () => {
    expectTypeOf(getGlobalPostgresConnectionString()).toEqualTypeOf<string | undefined>();
    Reflect.set(globalThis, '__TEST_CONTAINER_NOT_A_STRING__', 42);
    expect(getGlobalRedisConnectionString() === undefined || typeof getGlobalRedisConnectionString() === 'string').toBe(
      true,
    );
    Reflect.deleteProperty(globalThis, '__TEST_CONTAINER_NOT_A_STRING__');
  });
});

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
