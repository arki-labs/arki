/**
 * Helpers that used to take `any`
 *
 * Each helper now has a precise type and checks its input at runtime instead of
 * trusting it. The `expectTypeOf` lines fail to compile if a type goes back to
 * `any`; the runtime lines pin the behaviour the new checks must keep.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Factory } from './factories';
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

  it('the registry accepts any factory and returns the type the caller names', () => {
    const registry = new FactoryRegistry();
    registry.register('game', gameFactory);
    expectTypeOf(registry.create<Game>('game')).toEqualTypeOf<Game>();
    expect(registry.createMany<Game>('game', 2)).toHaveLength(2);
    expect(() => registry.create('missing')).toThrow(/not registered/);
  });

  it('IntegrationTesterConfig takes a map of any factory type', () => {
    type BaseFactories = NonNullable<
      IntegrationTesterConfig<Record<string, never>, never, never, never, never>['baseFactories']
    >;
    expectTypeOf<{ game: Factory<Game> }>().toExtend<BaseFactories>();
    expectTypeOf<BaseFactories['game']>().not.toBeAny();
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
    Record<string, unknown>
  >;

  it('withTransaction returns nothing, because the transaction always rolls back', () => {
    expectTypeOf<AnyTester['withTransaction']>().returns.resolves.toBeVoid();
  });

  it('seed takes arrays of objects keyed by table name', () => {
    expectTypeOf<AnyTester['seed']>().parameter(0).toEqualTypeOf<Record<string, readonly object[]>>();
  });
});
