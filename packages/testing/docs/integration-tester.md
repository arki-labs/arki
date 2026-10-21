# Integration tester

`IntegrationTester` gives a backend test a real Postgres, a real Redis, your repositories, and callers for each role. Every example here needs Docker and an app's own schema, migrations and caller, so each fence is skipped with that reason.

## Set up

### 1. Describe the app once

`initTester` takes your schema, migrations folder and factories. `tester.db` is whatever `createDatabase` returns, so build it like production (same relations).

```ts skip="needs an app's schema, migrations, context and caller"
import { initDbWithOptions } from '@arki/db/init';
import { initTester } from '@arki/testing/server/tester-builder';

import type { Database } from '../../db';
import { createRepositories } from '../../db';
import { relations } from '../../relations';
import { schema } from '../../schema';
import { createContext } from '../context';
import { createCaller } from '../trpc';
import { factories } from './factories';

const t = initTester
  .context<AppContext>()
  .caller<Caller>()
  .create({
    schema,
    migrationsFolder: './migrations',
    createDatabase: connectionString => initDbWithOptions({ connectionString }, { relations }),
    // Takes the root database or the transaction of `withTransaction`.
    createRepositories: (db: Database) => createRepositories(db),
    createContext: ({ db, repo, kv }) => createContext({ db, repo, kv }),
    createCaller: ({ context }) => createCaller(context),
    defaultUsers: {
      user: { id: 'usr_test', email: 'user@example.com', name: 'Test User' },
      moderator: { id: 'usr_mod', email: 'mod@example.com', name: 'Test Moderator', roles: ['moderator'] },
      admin: { id: 'usr_admin', email: 'admin@example.com', name: 'Test Admin', roles: ['admin'] },
    },
  });

// `tester.factory` is exactly the `factories` object, with its types.
export const createTester = t.tester.withFactories(factories);
```

### 2. Start the containers once per run

```ts skip="needs Docker and a Vitest globalSetup file"
import { setupGlobalTestContainers, teardownGlobalTestContainers } from '@arki/testing/containers';

export async function setup() {
  await setupGlobalTestContainers();
}

export async function teardown() {
  await teardownGlobalTestContainers();
}
```

```ts skip="needs the app's Vitest config file"
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './vitest.setup.ts',
    pool: 'forks',
    testTimeout: 30000,
    hookTimeout: 60000,
    environment: 'node',
  },
});
```

### 3. Write a test

```ts skip="needs an app's tester, schema and caller"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTester } from '../../../core/__tests__/tester';
import { games } from '../schema';

describe('games', () => {
  const tester = createTester();

  beforeAll(async () => {
    await tester.setup();
  }, 60000);
  afterAll(async () => {
    await tester.teardown();
  });
  beforeEach(async () => {
    await tester.clearTables(games);
  });

  it('creates a game', async () => {
    await tester.withTransaction(async () => {
      const result = await tester.caller.user.games.create({ name: 'Chess', slug: 'chess', status: 'active' });

      tester.assertValidId(result.id, 'game_');
      tester.assertTimestamps(result);
      expect(result.name).toBe('Chess');
    });
  });
});
```

## Lifecycle

`setup()` connects to the containers and migrates. `teardown()` closes the connections. `withTransaction(fn)` runs `fn` in a transaction and rolls it back when `fn` ends. Only the tester's own connection takes part: code that opens another connection commits for real.

## What the tester holds

```ts skip="needs an initialised tester"
tester.db; // the database createDatabase returned
tester.repo; // your repositories
tester.kv; // the Redis-backed KV store

tester.caller.public; // unauthenticated
tester.caller.user; // a regular user
tester.caller.moderator;
tester.caller.admin;

const custom = tester.createCustomCaller({ id: 'usr_custom', email: 'custom@example.com', name: 'Custom User' });
```

## Clean up tables

```ts skip="needs an initialised tester and app tables"
await tester.clearTables(users, games, sessions);
await tester.clearAllTables();
await tester.clearTablesByPattern(/^temp_/);
await tester.clearTablesExcept(users, settings);
```

## Seed

```ts skip="needs an initialised tester and app tables"
await tester.seed({
  users: [user1, user2],
  games: [game1],
});
```

## Check results

```ts skip="needs an initialised tester"
tester.assertValidId(game.id, 'game_');
tester.assertTimestamps(game);
tester.assertUpdatedAfterCreated(game);
tester.assertPaginatedResponse(result);
```

The tester also exposes `tester.assert`, `tester.debug` and `tester.performance`, which are the helpers in [Factories and assertions](factories-and-assertions.md) and [Debug and performance](debug-and-performance.md), and `tester.faker`.

## Random data

```ts skip="needs an initialised tester"
const email = tester.generateEmail(); // 'test-a1b2c3d4@example.com'
const slug = tester.generateSlug();
const url = tester.generateUrl();
const token = tester.generateString(32);
const phone = tester.generatePhone();
const score = tester.generateBetween(0, 100);
const status = tester.generateFromEnum(['active', 'inactive', 'pending']);
const date = tester.generateDate({ past: { years: 1 } });

const seed = tester.getRandomSeed(); // print it when a failure needs a replay
tester.resetRandomCounter(); // restart the sequence
```

## Habits that keep tests fast and honest

- Prefer `withTransaction` to `clearTables`. A rollback is faster than deleting rows.
- Build data with factories, not object literals. One factory change then updates every test.
- Read through repositories (`tester.repo.users.findById(id)`), the way production code does.
- Test each access level: call `tester.caller.public`, `user` and `admin` on the same procedure and assert who is refused.
- Nest `describe` by feature, then area, then access level. Name each `it` for one behaviour.

## Environment

- `DEBUG_TESTS=true` turns on debug logging.
- `setupGlobalTestContainers` sets `NODE_ENV`, `AUTH_SECRET`, `VITE_URL`, `DB_URL`, `REDIS_URL` and `KV_URL` for the run. It does not read an existing `DB_URL` or `REDIS_URL`.
