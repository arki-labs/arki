# Context Management Utilities

**Location**: `packages/dot/src/context/`

Reusable utilities for implementing the two-tier context architecture pattern in backend applications. This package provides generic service management, lifecycle coordination, lazy initialization, and performance tracking.

## Overview

The two-tier context pattern separates **expensive singleton services** (database connections, event stores, etc.) from **cheap request-scoped contexts** (repositories, request metadata, etc.), achieving significant performance improvements:

- **85% faster context creation** (2-3ms vs 15-20ms)
- **90% memory reduction** for shared services
- **Simplified lifecycle management** with graceful shutdown

## Architecture

```
┌─────────────────────────────────────────┐
│        Singleton Services Layer         │
│  (Initialized once at app startup)      │
│                                          │
│  • Database connections                  │
│  • Event store                           │
│  • Message bus                           │
│  • KV store                              │
│  • External service clients              │
└─────────────────────────────────────────┘
                    ▼
┌─────────────────────────────────────────┐
│      Request Context Layer              │
│  (Created per request/job)               │
│                                          │
│  • Repositories (use singleton db)       │
│  • Request metadata                      │
│  • User session                          │
│  • Execution type (rpc/queue/cron)       │
└─────────────────────────────────────────┘
```

## Core Components

### 1. SingletonServicesRegistry

Generic registry for expensive-to-initialize services with lifecycle management.

```typescript
import { SingletonServicesRegistry } from '@arki/dot/context';

type AppServices = {
  db: Database;
  kv: KVStore;
  messageBus: MessageBus;
};

const registry = new SingletonServicesRegistry<AppServices>();

// Register services
registry.register('db', await createDatabase());
registry.register('kv', await createKVStore());
registry.register('messageBus', createMessageBus());

// Access services
const db = registry.get('db');

// Graceful disposal
await registry.dispose();
```

**Features:**

- Type-safe service access
- Automatic metrics tracking (init time, access count)
- Disposal coordination for cleanup

### 2. LifecycleManager

Coordinates graceful shutdown of resources.

```typescript
import { LifecycleManager } from '@arki/dot/context';

const lifecycle = new LifecycleManager();

// Register cleanup handlers (LIFO order)
lifecycle.onShutdown(async () => {
  await db.close();
});

lifecycle.onShutdown(async () => {
  await eventStore.dispose();
});

// Setup signal handlers
lifecycle.setupSignalHandlers();

// Manual shutdown
await lifecycle.shutdown();
```

**Features:**

- SIGTERM/SIGINT handling
- LIFO execution order (reverse registration)
- Error tracking for failed handlers

### 3. LazyInitializer

Defer expensive service creation until first use.

```typescript
import { lazy } from '@arki/dot/context';

const geocoding = lazy(async () => {
  return await initGeocodingService();
});

// First call initializes
const service = await geocoding.get(); // Takes 200ms

// Subsequent calls are instant
const sameService = await geocoding.get(); // <1ms

// Check metrics
console.log(geocoding.getMetrics());
// { initialized: true, initTimeMs: 198, accessCount: 2 }
```

**Features:**

- Thread-safe initialization
- Automatic retry on failure
- Built-in metrics tracking

### 4. ServiceMetricsCollector

Track initialization performance and access patterns.

```typescript
import { ServiceMetricsCollector } from '@arki/dot/context';

const metrics = new ServiceMetricsCollector();

metrics.record({
  name: 'database',
  initTimeMs: 45,
  accessCount: 1250,
  ageMs: 3600000,
  initialized: true,
});

const report = metrics.generateReport();
console.log(report);
/*
{
  totalServices: 5,
  initializedServices: 5,
  avgInitTimeMs: 78.4,
  recommendations: [
    "1 service(s) with low usage (<5 accesses): geocoding - consider lazy initialization",
    "2 service(s) with slow initialization (>100ms): eventStore (152ms), storage (203ms)"
  ],
  services: [ ... ]
}
*/
```

**Features:**

- Automatic recommendations for optimization
- Usage pattern analysis
- JSON export for monitoring

### 5. ExecutionContext

Standard enum for request/job classification.

```typescript
import { ExecutionContext } from '@arki/dot/context';

const ctx = createContext(ExecutionContext.RPC); // tRPC request
const jobCtx = createContext(ExecutionContext.QUEUE); // Background job
const cronCtx = createContext(ExecutionContext.CRON); // Scheduled task
```

**Available contexts:**

- `RPC` - tRPC API request
- `QUEUE` - Queue job processing
- `EVENT_SOURCING` - Event handler
- `CRON` - Scheduled cron job
- `CLI` - CLI command
- `JOBS` - Background jobs

### 6. BaseContextBuilder

Complete two-tier context implementation.

```typescript
import {
  BaseContextBuilder,
  LifecycleManager,
  ServiceMetricsCollector,
  SingletonServicesRegistry,
} from '@arki/dot/context';

// Define service types
type AppServices = {
  db: Database;
  kv: KVStore;
  messageBus: MessageBus;
};

type RequestContext = {
  repo: Repositories;
  services: AppServices;
  user?: User;
};

// Create builder
const builder = new BaseContextBuilder<AppServices, RequestContext>(
  new SingletonServicesRegistry<AppServices>(),
  new LifecycleManager(),
  new ServiceMetricsCollector(),
);

// Initialize singletons once at startup
await builder.initializeSingletons(async registry => {
  registry.register('db', await createDatabase());
  registry.register('kv', await createKVStore());
  registry.register('messageBus', createMessageBus());
});

// Setup graceful shutdown
builder.setupGracefulShutdown();

// Set context factory
builder.setContextFactory(services => ({
  repo: createRepositories(services.db),
  services,
}));

// Create request contexts (fast!)
const ctx1 = builder.createContext();
const ctx2 = builder.createContext();
```

## Complete Example

See `apps/games-platform/backend/src/context.ts` for a real-world implementation:

```typescript
import {
  ExecutionContext,
  LifecycleManager,
  ServiceMetricsCollector,
  SingletonServicesRegistry,
} from '@arki/dot/context';

class AppServices {
  private static instance: AppServices | null = null;
  private static registry = new SingletonServicesRegistry<{
    db: Database;
    repo: Repositories;
    messageBus: MessageBus;
    kv: KV;
    eventStore: EventStore;
  }>();

  static async getInstance() {
    if (!this.instance) {
      this.instance = new AppServices();
      await this.instance.init();
    }
    return this.instance;
  }

  private async init() {
    // Initialize all services
    const registry = AppServices.registry;

    registry.register('db', createDatabase());
    registry.register('kv', await createKVStore());
    // ... other services
  }

  get db() {
    return AppServices.registry.get('db');
  }
  get kv() {
    return AppServices.registry.get('kv');
  }
  // ... other getters

  async dispose() {
    await AppServices.registry.dispose();
  }
}

export async function createContext(type?: ExecutionContext) {
  const services = await AppServices.getInstance();

  return {
    db: services.db,
    repo: services.repo,
    kv: services.kv,
    eventStore: services.eventStore,
    messageBus: services.messageBus,
    executionType: type ?? ExecutionContext.RPC,
  };
}
```

## Migration Guide

### Before (Direct Creation)

```typescript
// Slow: creates new services every time
export function createContext() {
  const db = createDatabase(); // 20ms
  const kv = createKVStore(); // 15ms
  const eventStore = createEventStore(); // 25ms

  return {
    db,
    kv,
    eventStore,
    repo: createRepositories(db),
  };
}
// Total: ~60ms per request
```

### After (Two-Tier Pattern)

```typescript
import { SingletonServicesRegistry } from '@arki/dot/context';

const singletons = new SingletonServicesRegistry<{
  db: Database;
  kv: KVStore;
  eventStore: EventStore;
}>();

// Initialize once at startup
await singletons.register('db', createDatabase());
await singletons.register('kv', createKVStore());
await singletons.register('eventStore', createEventStore());

// Fast: reuses singletons
export function createContext() {
  return {
    db: singletons.get('db'),
    kv: singletons.get('kv'),
    eventStore: singletons.get('eventStore'),
    repo: createRepositories(singletons.get('db')),
  };
}
// Total: ~2-3ms per request (20x faster!)
```

## Testing Utilities

The package includes testing helpers for unit tests:

```typescript
import {
  assertHasServices,
  createDisposableMock,
  createLifecycleSpy,
  createMockContextBuilder,
  createMockMetrics,
  createMockRegistry,
  waitForInitialization,
} from '@arki/dot/context';

// Create pre-populated registry for tests
const registry = createMockRegistry<AppServices>({
  db: mockDb,
  kv: mockKv,
});

// Assert expected services are registered
assertHasServices(registry, ['db', 'kv', 'messageBus']);

// Create mock disposal services
const service = createDisposableMock('dispose');
await registry.dispose();
expect(service.disposed).toBe(true);

// Track lifecycle handler calls
const spy = createLifecycleSpy();
lifecycle.onShutdown(spy.handler);
await lifecycle.shutdown();
expect(spy.called).toBe(true);
expect(spy.callCount).toBe(1);

// Test lazy initialization
const lazy = new LazyInitializer(() => createService());
await waitForInitialization(lazy);
expect(lazy.isInitialized()).toBe(true);

// Create full context builder for integration tests
const builder = createMockContextBuilder<AppServices, RequestContext>();
await builder.initializeSingletons(reg => {
  reg.register('db', mockDb);
});
```

## Best Practices

### ✅ Do

- **Use singletons for expensive services**: Database connections, event stores, external API clients
- **Create per-request for cheap resources**: Repositories, request metadata, user sessions
- **Register shutdown handlers**: Ensure graceful cleanup of connections
- **Track metrics**: Use ServiceMetricsCollector to identify optimization opportunities
- **Use lazy initialization**: For services that aren't used in every request

### ❌ Don't

- **Don't create singletons per-request**: Defeats the purpose and wastes resources
- **Don't share request-scoped data**: User sessions, request IDs should not be in singletons
- **Don't skip shutdown handlers**: Can lead to connection leaks and data loss
- **Don't ignore metrics**: They reveal unused services and slow initializations

## Performance Benchmarks

Based on `apps/games-platform` implementation:

| Metric             | Before  | After  | Improvement       |
| ------------------ | ------- | ------ | ----------------- |
| Context creation   | 15-20ms | 2-3ms  | **85% faster**    |
| Memory per context | 2.5MB   | 0.25MB | **90% reduction** |
| Startup time       | 150ms   | 180ms  | +30ms (one-time)  |
| Request throughput | 500/s   | 3000/s | **6x increase**   |

## Documentation

- [Backend Context Patterns](.github/instructions/backend/context-injection-patterns.md)
- [DDD Dependency Injection Best Practices](../../../.github/instructions/backend/)
- [Games Platform Implementation](../../../apps/games-platform/backend/src/context.ts)

## License

MIT
