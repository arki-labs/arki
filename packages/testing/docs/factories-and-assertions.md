# Factories and assertions

All of this is exported from `@arki/testing`, needs no Docker, and runs as written.

## Factories

`createFactory(generator, defaults?)` returns a function. Call it with overrides to get the object. Call it with no arguments to get a builder.

```ts run
import { createFactory, createMany, createSequence, faker } from '@arki/testing';

type Session = { id: string; userId: string; score: number };

faker.seed(1);
const sessionFactory = createFactory<Session>(() => ({
  id: faker.string.alphanumeric(8),
  userId: faker.string.alphanumeric(8),
  score: 0,
}));

const one = sessionFactory({ score: 10 });
const built = sessionFactory().with('score', 20).withMany({ userId: 'usr_ada' }).build();
const five = createMany(sessionFactory, 5, index => ({ score: index * 10 }));
const ranked = createSequence(sessionFactory, 'score', [100, 200, 300]);

console.log(one.score, built.score, built.userId, five.length, ranked.map(session => session.score).join(','));
```

```text
10 20 usr_ada 5 100,200,300
```

`createMany(factory, count, overrides)` takes an object or a function of the index. `createSequence(factory, field, values)` makes one object per value.

### Several factories

`createFactories` groups factories into one typed object. `FactoryRegistry` looks them up by name, and each name keeps its own result type.

```ts run
import { createFactories, createFactory, FactoryRegistry } from '@arki/testing';

type User = { name: string };
type Game = { title: string };

const userFactory = createFactory<User>(() => ({ name: 'Ada' }));
const gameFactory = createFactory<Game>(() => ({ title: 'Chess' }));

const factories = createFactories({ user: userFactory, game: gameFactory });
const registry = new FactoryRegistry({ user: userFactory, game: gameFactory });

console.log(
  factories.user().build().name,
  registry.create('game', { title: 'Go' }).title,
  registry.createMany('user', 2).length,
);
```

```text
Ada Go 2
```

`withFactories(factories)` on a tester puts the object on `tester.factory`. See [Integration tester](integration-tester.md).

## Assertions

Every assertion throws an `Error` that names the field, the expected value and the actual value.

```ts run
import {
  assertArrayEmpty,
  assertArrayLength,
  assertArrayNotEmpty,
  assertArraySorted,
  assertContainsId,
  assertDeepPartialMatch,
  assertErrorThrown,
  assertNoError,
  assertNotContainsId,
  assertOneOf,
  assertPaginationValid,
  assertTimestampRecent,
} from '@arki/testing';

const games = [
  { id: 'game_1', name: 'Chess', status: 'active', createdAt: new Date(Date.now() - 2000) },
  { id: 'game_2', name: 'Go', status: 'draft', createdAt: new Date(Date.now() - 1000) },
];

assertPaginationValid({ items: games, total: 2, hasMore: false }, { itemsCount: 2, total: 2, hasMore: false });
assertTimestampRecent(games[0]?.createdAt, { withinSeconds: 5 });
assertContainsId(games, 'game_1');
assertNotContainsId(games, 'game_9');
assertArrayLength(games, 2);
assertArrayNotEmpty(games);
assertArrayEmpty([]);
assertArraySorted(games, 'createdAt', 'asc');
assertDeepPartialMatch(games[0], { name: 'Chess' });
assertOneOf(games[0]?.status, ['active', 'draft', 'archived']);
await assertNoError(async () => 'fine');
const caught = await assertErrorThrown(async () => Promise.reject(new Error('game not found')), /not found/);

console.log(caught.message);
```

```text
game not found
```

`assertPaginationValid` also takes `itemSchema`, any Standard Schema (Zod, Valibot, ArkType), and checks every item against it. `assertMatchesSchema(value, schema)` checks one value. `assertTimestamps(obj)` and `assertUpdatedAfterCreated(obj)` accept a `Date`, a Temporal `Instant` or a `ZonedDateTime`.
