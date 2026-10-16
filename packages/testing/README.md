# @arki/testing

Comprehensive testing utilities for tRPC + Drizzle + PostgreSQL + Redis applications in the Arki monorepo.

> **Built on the same TDD discipline as the rest of the workspace.** Primitives land here when a real consumer test drives their shape — not before. See [Adding a New Primitive](#adding-a-new-primitive-lift-after-second-use) below for the lift workflow, and see the workspace `test-driven-development` skill for the broader red-green-refactor playbook.

## Features

- ✅ **Integration Testing** - Full-featured `IntegrationTester` class with container lifecycle management
- ✅ **Test Data Factories** - Flexible factory system with both function and builder patterns
- ✅ **Enhanced Assertions** - Rich assertion library for common testing patterns
- ✅ **Debug Utilities** - Powerful debugging tools for inspecting database state
- ✅ **Performance Testing** - Measure and benchmark operation performance
- ✅ **Type-Safe** - Full TypeScript support with proper generic constraints
- ✅ **Container Management** - Automated PostgreSQL and Redis testcontainer setup
- ✅ **Test Isolation** - Transaction-based rollback for clean test state
- ✅ **Random Data Generation** - Deterministic generators for reproducible tests
- ✅ **HTTP Mocking (MSW)** - Network-layer intercepts via `setupMswServer()` from `@arki/testing/msw`

## Installation

```bash
pnpm add @arki/testing --filter=your-app
```

## Quick Start

### 1. Create Tester Class

```typescript
// apps/your-app/backend/src/core/__tests__/tester.ts
import { initDbWithOptions } from '@arki/db/init';
import { initTester } from '@arki/testing/server/tester-builder';

import type { Database } from '../../db';
import { createContext } from '../context';
import { createCaller } from '../trpc';
import { createRepositories } from '../../db';
import { relations } from '../../relations';
import { schema } from '../../schema';
import { factories } from './factories';

const t = initTester
  .context<AppContext>()
  .caller<Caller>()
  .create({
    schema,
    migrationsFolder: './migrations',
    // The one place the database type comes from: `tester.db` is whatever this returns.
    // Build it like production (same relations).
    createDatabase: connectionString => initDbWithOptions({ connectionString }, { relations }),
    // Takes the root database or the transaction of `withTransaction` (here `Database = Db | Transaction`).
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

### 2. Global Vitest Setup

```typescript
// apps/your-app/backend/vitest.setup.ts
import { setupGlobalTestContainers, teardownGlobalTestContainers } from '@arki/testing/containers';

export async function setup() {
  await setupGlobalTestContainers();
}

export async function teardown() {
  await teardownGlobalTestContainers();
}
```

### 3. Vitest Configuration

```typescript
// apps/your-app/backend/vitest.config.ts
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

### 4. Write Tests

```typescript
// apps/your-app/backend/src/features/games/__tests__/games.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Tester } from '../../../core/__tests__/tester';
import { games } from '../schema';

describe('Games Feature', () => {
  const tester = new Tester();

  beforeAll(async () => {
    await tester.setup();
  }, 60000);

  afterAll(async () => {
    await tester.teardown();
  });

  beforeEach(async () => {
    await tester.clearTables(games);
  });

  describe('Create Game', () => {
    it('should create a game', async () => {
      await tester.withTransaction(async () => {
        // Arrange
        const gameData = {
          name: 'Chess',
          slug: 'chess',
          status: 'active' as const,
        };

        // Act
        const result = await tester.caller.user.games.create(gameData);

        // Assert
        tester.assertValidId(result.id, 'game_');
        tester.assertTimestamps(result);
        expect(result.name).toBe('Chess');
      });
    });
  });
});
```

## Core API

### IntegrationTester

The main testing class providing comprehensive utilities.

#### Lifecycle Methods

```typescript
// Initialize containers and database
await tester.setup();

// Cleanup and stop containers
await tester.teardown();

// Execute code with automatic rollback
await tester.withTransaction(async () => {
  // Your test code
  // Transaction automatically rolls back after this
});
```

#### Database Access

```typescript
// Direct database access
tester.db; // NodePgDatabase instance
tester.repo; // Your repositories
tester.kv; // Redis/KV store

// tRPC callers for different roles
tester.caller.public; // Unauthenticated
tester.caller.user; // Regular user
tester.caller.moderator; // Moderator
tester.caller.admin; // Admin

// Create custom caller
const customCaller = tester.createCustomCaller({
  id: 'usr_custom',
  email: 'custom@example.com',
  name: 'Custom User',
});
```

#### Table Cleanup

```typescript
// Clear specific tables
await tester.clearTables(users, games, sessions);

// Clear all tables
await tester.clearAllTables();

// Clear tables matching pattern
await tester.clearTablesByPattern(/^temp_/);

// Clear all except specified tables
await tester.clearTablesExcept(users, settings);
```

#### Seeding Data

```typescript
// Seed database with test data
await tester.seed({
  users: [user1, user2, user3],
  games: [game1, game2],
  sessions: [session1, session2, session3],
});
```

#### Assertions

```typescript
// Validate branded IDs
tester.assertValidId(game.id, 'game_');

// Validate timestamps
tester.assertTimestamps(game);
tester.assertUpdatedAfterCreated(game);

// Validate pagination
tester.assertPaginatedResponse(result);
```

#### Random Data Generation

```typescript
// Generate deterministic test data
const slug = tester.generateSlug(); // 'test-a1b2c3d4'
const email = tester.generateEmail(); // 'test-a1b2c3d4@example.com'
const url = tester.generateUrl(); // 'https://example.com/test-a1b2c3d4'
const token = tester.generateString(32);

// Enhanced generators
const phone = tester.generatePhone(); // '+1-555-123-4567'
const score = tester.generateBetween(0, 100);
const status = tester.generateFromEnum(['active', 'inactive', 'pending']);
const date = tester.generateDate({ past: { years: 1 } });

// Get seed for debugging
const seed = tester.getRandomSeed();

// Reset for reproducible sequences
tester.resetRandomCounter();
```

#### Utility Access

```typescript
// Enhanced assertions
tester.assert.assertPaginationValid(result, { itemsCount: 10 });
tester.assert.assertTimestampRecent(user.createdAt, { withinSeconds: 5 });
tester.assert.assertContainsId(games, 'game_123');

// Debug utilities
tester.debug.logState('User after update', user);
await tester.debug.dumpDatabase(tester.db);

// Performance measurement
const perfResult = await tester.performance.measurePerformance(
  'Create 100 users',
  async () => {
    for (let i = 0; i < 100; i++) {
      await createUser();
    }
  },
  { maxMs: 1000 },
);

// Faker for custom data
const name = tester.faker.person.fullName();
const avatar = tester.faker.image.avatar();
```

## Factory System

### Creating Factories

```typescript
import { createFactory, faker } from '@arki/testing';

// Define a factory
const userFactory = createFactory<User>(() => ({
  id: createUserId(),
  email: faker.internet.email(),
  name: faker.person.fullName(),
  avatar: faker.image.avatar(),
  createdAt: faker.date.past(),
  updatedAt: new Date(),
}));
```

### Using Factories

```typescript
// Create many
// Create sequence
import { createMany, createSequence } from '@arki/testing';

// Function pattern - direct creation with overrides
const user1 = userFactory({ email: 'test@example.com' });

// Builder pattern - fluent API
const user2 = userFactory().with('email', 'admin@example.com').with('name', 'Admin User').build();

const users = createMany(userFactory, 5);
const users = createMany(userFactory, 5, { status: 'active' });
const users = createMany(userFactory, 5, index => ({
  email: `user${index}@example.com`,
}));

const sessions = createSequence(sessionFactory, 'score', [100, 200, 300, 400, 500]);
```

### Factories on the tester

`withFactories(factories)` puts the object you pass on `tester.factory`, with its exact type. A tester made with `t.tester.create()` has no `factory`.

```typescript
const factories = createFactories({ user: userFactory, game: gameFactory });
const createTester = t.tester.withFactories(factories);

const tester = createTester();
const user = tester.factory.user({ email: 'test@example.com' }); // User
const draft = tester.factory.game().with('name', 'Chess').build(); // builder pattern
```

`factory()` with no arguments returns a `FactoryBuilder`; `factory(overrides)` returns the object.

### Factory Registry

To look factories up by name, build a `FactoryRegistry` from a map. Each name has its own result type:

```typescript
const registry = new FactoryRegistry({ user: userFactory, game: gameFactory });

const user = registry.create('user', { email: 'test@example.com' }); // User
const games = registry.createMany('game', 10); // Game[]
registry.create('nope'); // compile error
```

## Enhanced Assertions

```typescript
import { assertContainsId, assertPaginationValid, assertTimestampRecent } from '@arki/testing';

// Pagination validation
assertPaginationValid(result, {
  itemsCount: 10,
  total: 25,
  hasMore: true,
  itemSchema: gameSchema, // Optional Standard Schema (zod, valibot, arktype, ...)
});

// Recent timestamp (default: within 10 seconds)
assertTimestampRecent(user.createdAt, { withinSeconds: 5 });

// Array contains/doesn't contain ID
assertContainsId(games, 'game_123');
assertNotContainsId(games, 'game_deleted');

// Error assertions
await assertErrorThrown(async () => tester.caller.user.games.delete({ id: 'invalid' }), /not found/i);

await assertNoError(async () => tester.caller.user.games.get({ id: 'game_123' }));

// Array assertions
assertArrayLength(games, 10);
assertArrayNotEmpty(games);
assertArrayEmpty(archivedGames);
assertArraySorted(games, 'createdAt', 'desc');

// Deep partial matching
assertDeepPartialMatch(game, {
  name: 'Chess',
  status: 'active',
  metadata: { difficulty: 'hard' },
});

// Value in set
assertOneOf(game.status, ['active', 'draft', 'archived']);

// Schema validation
assertMatchesSchema(game, gameSchema);
```

## Debug Utilities

```typescript
import { configureDebug, createDebugContext, dumpDatabase, logDebug, logState } from '@arki/testing';

// Enable debug logging
configureDebug({ enabled: true });

// Or use environment variable
// DEBUG_TESTS=true vitest

// Log debug messages
logDebug('Creating test user', { email: 'test@example.com' });

// Log SQL queries
logQuery('SELECT * FROM users WHERE id = $1', ['usr_123']);

// Log object state
logState('User after update', user);

// Dump database tables
await dumpDatabase(tester.db);
await dumpTable(tester.db, 'users', 10);

// Section headers
logSection('Setup test data');

// Timing operations
const timer = timeOperation('Creating 100 users');
// ... do work ...
timer.end(); // Logs: "[TIMING] Creating 100 users: 1234ms"

// Scoped debug context
const debug = createDebugContext('UserTests');
debug.log('Creating user');
debug.state('User', user);
debug.section('Validation Phase');
```

## HTTP Mocking (MSW)

For unit/integration tests that exercise production code calling external HTTP services (REST APIs, webhooks, third-party SaaS), use the `@arki/testing/msw` subpath. It wraps [MSW](https://mswjs.io) (Mock Service Worker) with Vitest lifecycle wiring and a fail-loud default, so you can intercept network calls at the request layer without stubbing `globalThis.fetch`.

### Why MSW (not `vi.stubGlobal('fetch')`)

- The impl really calls `fetch()` with the real URL — so `encodeURIComponent`, header construction, query-string building, and URL parsing all execute for real.
- `onUnhandledRequest: 'error'` (the default) catches accidental real-network calls **and** URL-construction bugs: an un-encoded slug that breaks the path shape will fail the test instead of silently hitting a different stub.
- Handlers are declarative — you write *"for this URL, respond with this"* — instead of imperatively re-stubbing a global.

### Setup (one-time, per app)

```typescript
// apps/your-app/backend/__tests__/setup/msw.ts
import { setupMswServer } from '@arki/testing/msw';

export const server = setupMswServer();
```

```typescript
// apps/your-app/backend/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./__tests__/setup/msw.ts'],
    // ...
  },
});
```

`setupMswServer()` registers `beforeAll(listen)`, `afterEach(resetHandlers)`, and `afterAll(close)` by side effect. Default policy is `onUnhandledRequest: 'error'`. Pass `{ onUnhandledRequest: 'warn' | 'bypass' }` to relax it during migration.

### Usage in tests

```typescript
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from '@arki/testing/msw';

import { fetchGreenhouse } from '../src/features/ingestion/sources/greenhouse';
import { server } from './setup/msw';

const GH_URL = 'https://boards-api.greenhouse.io/v1/boards/:slug/jobs';

describe('fetchGreenhouse', () => {
  it('maps a posting', async () => {
    server.use(http.get(GH_URL, () => HttpResponse.json({ jobs: [{ id: 1 }] })));
    const rows = await fetchGreenhouse('stripe');
    expect(rows).toHaveLength(1);
  });

  it('throws on 503', async () => {
    server.use(http.get(GH_URL, () => new HttpResponse(null, { status: 503 })));
    await expect(fetchGreenhouse('downco')).rejects.toThrow(/503/);
  });

  it('url-encodes the slug', async () => {
    // MSW path params (`:slug`) match a single URL segment. If the impl forgets
    // to encode a slug containing `/`, MSW gets an unmatched request and the
    // 'error' policy fails the test automatically — no extra assertion needed.
    let capturedUrl: string | null = null;
    server.use(http.get(GH_URL, ({ request }) => {
      capturedUrl = request.url;
      return HttpResponse.json({ jobs: [] });
    }));

    await fetchGreenhouse('weird slug/with-chars');

    expect(capturedUrl).toBe(
      'https://boards-api.greenhouse.io/v1/boards/weird%20slug%2Fwith-chars/jobs',
    );
  });
});
```

The `@arki/testing/msw` subpath re-exports the common authoring surface (`http`, `HttpResponse`, `passthrough`, `delay`, and core types), so your tests don't need a direct `msw` dependency — `@arki/testing` is the single import surface and the single place to upgrade the MSW version monorepo-wide.

### Patterns

- **Per-test handlers:** prefer `server.use(...)` inside `it(...)` over registering at setup. Handlers reset after each test (`afterEach`), keeping tests isolated.
- **Capturing request shape:** when you need to assert the URL or body the impl sent, capture `request.url` / `await request.json()` inside the handler and assert after.
- **Fail-loud:** the `'error'` default is intentional. Don't lower it to `'warn'` to silence noise — investigate why the test is making an unmocked request (usually a URL bug worth fixing).
- **Live the real Request/Response:** `HttpResponse.json(body)` is the canonical helper; for non-JSON or no-body responses use `new HttpResponse(null, { status, statusText })` or `new HttpResponse(text, { status, headers })`.

## Performance Testing

```typescript
import {
  assertPerformance,
  benchmarkQuery,
  comparePerformance,
  createPerformanceTracker,
  measurePerformance,
} from '@arki/testing';

// Measure with threshold
const result = await measurePerformance(
  'Create 100 users',
  async () => {
    for (let i = 0; i < 100; i++) {
      await createUser();
    }
  },
  { maxMs: 1000 }, // Throws if exceeds
);

// Benchmark query
const stats = await benchmarkQuery(
  'Get user by ID',
  () => tester.repo.users.findById('usr_123'),
  100, // iterations
);
// Output: avg, min, max, p50, p95, p99

// Compare implementations
const comparison = await comparePerformance(
  {
    'Method A': () => methodA(),
    'Method B': () => methodB(),
    'Method C': () => methodC(),
  },
  20,
);
// Shows ranked results with percentage differences

// Assert performance
const user = await assertPerformance(
  'Get user by ID',
  () => tester.repo.users.findById('usr_123'),
  100, // maxMs
);

// Track multiple operations
const tracker = createPerformanceTracker();

await tracker.measure('Setup', async () => {
  // setup code
});

await tracker.measure(
  'Main operation',
  async () => {
    // main code
  },
  { maxMs: 500 },
);

tracker.printSummary();
```

## Best Practices

### Test Structure

Follow the three-level describe nesting pattern:

```typescript
describe('Feature Name', () => {
  const tester = new Tester();

  beforeAll(async () => {
    await tester.setup();
  }, 60000);

  afterAll(async () => {
    await tester.teardown();
  });

  beforeEach(async () => {
    await tester.clearTables(...tables);
  });

  describe('Functional Area', () => {
    describe('Access Level / Use Case', () => {
      it('should do something specific', async () => {
        await tester.withTransaction(async () => {
          // Arrange
          const data = tester.factory.create('entity');

          // Act
          const result = await tester.caller.user.method(data);

          // Assert
          expect(result).toBeDefined();
          tester.assertValidId(result.id, 'prefix_');
        });
      });
    });
  });
});
```

### Use Transaction Rollback

```typescript
// ✅ GOOD: Auto-rollback keeps database clean
it('should create user', async () => {
  await tester.withTransaction(async () => {
    const user = await createUser();
    expect(user.id).toBeDefined();
    // Transaction automatically rolls back
  });
});

// ❌ AVOID: Manual cleanup is slower
it('should create user', async () => {
  const user = await createUser();
  expect(user.id).toBeDefined();
  await tester.clearTables(users); // Slower
});
```

### Use Factories for Test Data

```typescript
// ✅ GOOD: Use factories
const game = tester.factory.create('game', { name: 'Chess' });

// ❌ AVOID: Manual object creation
const game = {
  id: createGameId(),
  name: 'Chess',
  slug: 'chess',
  description: 'A chess game',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
  // ... many more fields
};
```

### Use Repository Pattern

```typescript
// ✅ GOOD: Use repositories
const user = await tester.repo.users.findById('usr_123');

// ❌ AVOID: Direct database queries
const [user] = await tester.db.select().from(users).where(eq(users.id, 'usr_123'));
```

### Test All Access Levels

```typescript
describe('Get Game', () => {
  it('should allow public access', async () => {
    const result = await tester.caller.public.games.get({ id });
    expect(result).toBeDefined();
  });

  it('should allow authenticated access', async () => {
    const result = await tester.caller.user.games.get({ id });
    expect(result).toBeDefined();
  });

  it('should require admin for sensitive data', async () => {
    await assertErrorThrown(() => tester.caller.user.games.getAnalytics({ id }), /unauthorized/i);

    const result = await tester.caller.admin.games.getAnalytics({ id });
    expect(result).toBeDefined();
  });
});
```

## Migration Guide

### From Legacy Tester Class

**Before (v1):**

```typescript
// Manual type assertions, less type safety
const tester = new Tester();
await tester.clearTables(table1, table2); // any[] type
```

**After (v2):**

```typescript
// Full type safety with PgTable constraint
const tester = new Tester();
await tester.clearTables(users, games); // PgTable[] type

// New utilities available
await tester.clearAllTables();
await tester.clearTablesByPattern(/^temp_/);
await tester.seed({ users: [...], games: [...] });

// Enhanced assertions
tester.assert.assertPaginationValid(result, { itemsCount: 10 });

// Debug utilities
tester.debug.logState('Result', result);

// Performance testing
await tester.performance.measurePerformance('Operation', async () => {});
```

### From games-platform Factories

**Before (games-platform pattern):**

```typescript
// apps/games-platform/backend/src/__tests__/helpers/factories.ts
export function createTestGame(overrides?: Partial<Game>): Game {
  return {
    id: createGameId(),
    name: faker.word.words(2),
    // ...
    ...overrides,
  };
}
```

**After (@arki/testing):**

```typescript
// In your test setup
import { createFactory } from '@arki/testing';

const gameFactory = createFactory<Game>(() => ({
  id: createGameId(),
  name: tester.faker.word.words(2),
  // ...
}));

// In tests - function pattern (factories passed to withFactories)
const game = tester.factory.game({ name: 'Chess' });

// In tests - builder pattern
const game = gameFactory().with('name', 'Chess').with('status', 'active').build();
```

## TypeScript Configuration

The package uses strict type checking with no `any` types. Generic constraints ensure type safety:

```typescript
class IntegrationTester<
  TSchema extends Record<string, unknown>,
  TDatabase extends THandle, // the root database `createDatabase` returns (type of `tester.db`)
  TRepositories extends Record<string, unknown>,
  TCaller,
  TContext extends Record<string, unknown>,
  THandle extends TesterDatabase<THandle>, // root database or transaction, as repositories take it
>
```

All table operations use `PgTable` type from Drizzle ORM for proper type checking.

## Environment Variables

- `DEBUG_TESTS=true` - Enable debug logging
- `DB_URL` - Custom database connection (overrides testcontainers)
- `REDIS_URL` - Custom Redis connection (overrides testcontainers)

## Adding a New Primitive (lift-after-second-use)

`@arki/testing` is governed by the same TDD discipline as workspace production code: **a primitive only lands when a real consumer test drives its shape**. We do not anticipate; we lift after the second use.

### Why "second use"

A helper written for a single test optimizes for one call site. A helper written for two call sites discovers its real interface — what's actually shared vs. what was incidental. The first inline copy is a draft; the second use is the design review. By the third site, the lift has already paid for itself.

### Workflow

1. **First use — inline.** Write the helper directly in the consumer test file. Keep it as small as the one test demands. Don't generalize yet.
2. **Second use — stop and lift.** When another test (same app or another app) wants the same primitive, move it to `packages/testing/src/{name}.ts`. Wire it as a re-export from `src/index.ts` (eagerly evaluated) or expose via the `./*` subpath pattern (lazy-imported, like `@arki/testing/msw`).
3. **Test only what's non-trivial.** Tiny re-exports, one-line factories, and string formatters don't need their own tests — the consumers exercise them by virtue of using them. Primitives with non-trivial logic (lifecycle wiring, parsing, generator state, container orchestration) get their own focused test next to the source file.
4. **Document in this README.** Add a section explaining (a) **why** this exists vs. the obvious alternative, (b) **how** to set it up (the per-app boilerplate, if any), and (c) **one concrete usage example**. The "why" section is what stops future contributors from reinventing it.
5. **Pin via the workspace catalog.** External deps go in the root `package.json` under `catalogs.testing`, then `@arki/testing` references them as `catalog:testing`. This guarantees one version across the monorepo and one place to upgrade.

### What belongs in `@arki/testing`

- ✅ Lifecycle wiring — test containers, MSW server, Vitest hooks
- ✅ Assertion helpers that encode workspace conventions — prefixed IDs, branded types, pagination shape, timestamp recency
- ✅ Cross-cutting infrastructure — deterministic randomness, debug logging, performance measurement
- ✅ Cross-app entity factories (rare; most live in the consuming app and are passed to `withFactories(...)`)

### What does **not** belong here

- ❌ App-specific factories — those stay in the consuming app
- ❌ Anything used by only one app — wait for the second consumer
- ❌ Wrappers that add no value over the underlying library — re-exporting `HttpResponse` is fine; renaming it to `apiResponse` is noise
- ❌ Speculative "we might need this" helpers — YAGNI applies here the same way it applies to production code

### Real example

`@arki/testing/msw` was added after MSW setup boilerplate appeared in a second app. The 15-line `setupServer` + `beforeAll/afterEach/afterAll` block in app A was about to be copy-pasted into app B. That copy-paste was the trigger: the primitive was lifted, the re-exports of `http` / `HttpResponse` came with it (so consumers don't need a direct `msw` devDep), and the documentation explained *why* MSW over `vi.stubGlobal('fetch')` — the same explanation that would have lived in two test-file headers becomes one canonical reference.

## License

Private - Part of the Arki monorepo

## Related Packages

- `@arki/db` - Database utilities and ID factories
- `@arki/kv` - Redis/KV wrapper
- `@arki/auth` - Authentication utilities

## Support

For issues or questions, see the workspace documentation or contact the maintainers.
