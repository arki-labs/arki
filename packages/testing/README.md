# @arki/testing

Comprehensive testing utilities for tRPC + Drizzle + PostgreSQL + Redis applications in the Arki monorepo.

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

## Installation

```bash
pnpm add @arki/testing --filter=your-app
```

## Quick Start

### 1. Create Tester Class

```typescript
// apps/your-app/backend/src/core/__tests__/tester.ts
import { createIntegrationTester } from '@arki/testing';

import { createContext } from '../core/context';
import { createCaller } from '../core/trpc';
import { createRepositories } from '../db/repositories';
import { schema } from '../db/schema';

const TesterBase = createIntegrationTester({
  schema,
  migrationsFolder: './migrations',
  createContext: ({ db, repo, kv }) => createContext({ db, repo, kv }),
  createCaller: ({ context }) => createCaller(context),
  createRepositories: db => createRepositories(db),
  defaultUsers: {
    user: {
      id: 'usr_test',
      email: 'user@example.com',
      name: 'Test User',
    },
    moderator: {
      id: 'usr_mod',
      email: 'mod@example.com',
      name: 'Test Moderator',
      roles: ['moderator'],
    },
    admin: {
      id: 'usr_admin',
      email: 'admin@example.com',
      name: 'Test Admin',
      roles: ['admin'],
    },
  },
  // Optional: Register base factories available in all tests
  baseFactories: {
    user: userFactory,
    game: gameFactory,
    session: sessionFactory,
  },
});

export class Tester extends TesterBase {}
```

### 2. Global Vitest Setup

```typescript
// apps/your-app/backend/vitest.setup.ts
import { setupGlobalTestContainers, teardownGlobalTestContainers } from '@arki/testing';

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

### Factory Registry

```typescript
// Register factories
const tester = new Tester();
tester.factory.register('user', userFactory);
tester.factory.register('game', gameFactory);
tester.factory.register('session', sessionFactory);

// Use registered factories
const user = tester.factory.create('user', { email: 'test@example.com' });
const users = tester.factory.createMany('user', 5);
```

### Base Factories

Register factories once during tester configuration to make them available in all tests:

```typescript
// In tester.ts - define your factories
const userFactory = createFactory<User>(() => ({
  id: createUserId(),
  email: faker.internet.email(),
  name: faker.person.fullName(),
  createdAt: faker.date.past(),
  updatedAt: new Date(),
}));

const gameFactory = createFactory<Game>(() => ({
  id: createGameId(),
  name: faker.word.words(2),
  slug: faker.helpers.slugify(faker.word.words(2)),
  status: 'active',
  createdAt: faker.date.past(),
  updatedAt: new Date(),
}));

// Register as base factories
const TesterBase = createIntegrationTester({
  // ... other config
  baseFactories: {
    user: userFactory,
    game: gameFactory,
    session: sessionFactory,
  },
});

// In tests - factories are automatically available
const tester = new Tester();
await tester.setup();

const user = tester.factory.create('user');
const games = tester.factory.createMany('game', 10);
const customGame = tester.factory.create('game', { name: 'Chess' });

// You can still register additional test-specific factories
tester.factory.register('tempEntity', tempEntityFactory);
```

## Enhanced Assertions

```typescript
import { assertContainsId, assertPaginationValid, assertTimestampRecent } from '@arki/testing';

// Pagination validation
assertPaginationValid(result, {
  itemsCount: 10,
  total: 25,
  hasMore: true,
  itemSchema: gameSchema, // Optional Zod schema
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

tester.factory.register('game', gameFactory);

// In tests - function pattern
const game = tester.factory.create('game', { name: 'Chess' });

// In tests - builder pattern
const game = gameFactory().with('name', 'Chess').with('status', 'active').build();
```

## TypeScript Configuration

The package uses strict type checking with no `any` types. Generic constraints ensure type safety:

```typescript
class IntegrationTester<
  TSchema extends Record<string, unknown>,
  TDatabase extends NodePgDatabase<TSchema>,
  TRepositories extends Record<string, unknown>,
  TCaller,
  TContext extends Record<string, unknown>,
>
```

All table operations use `PgTable` type from Drizzle ORM for proper type checking.

## Environment Variables

- `DEBUG_TESTS=true` - Enable debug logging
- `DB_URL` - Custom database connection (overrides testcontainers)
- `REDIS_URL` - Custom Redis connection (overrides testcontainers)

## License

Private - Part of the Arki monorepo

## Related Packages

- `@arki/db` - Database utilities and ID factories
- `@arki/kv` - Redis/KV wrapper
- `@arki/auth` - Authentication utilities

## Support

For issues or questions, see the workspace documentation or contact the maintainers.
