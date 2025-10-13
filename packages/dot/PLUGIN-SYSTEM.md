# Dot Plugin System

The Dot Plugin System provides a clean, type-safe way to organize features in your application. Each feature can expose its components (routers, schemas, repositories, etc.) through a plugin, which is automatically registered and initialized during bootstrap.

## Benefits

- **Encapsulation**: Each feature manages its own components
- **Type Safety**: Full TypeScript support with **literal type inference** for plugin names
- **Dependency Management**: Type-safe plugin dependencies with automatic loading in dependency order
- **Clean Bootstrap**: Single file with just plugin imports
- **No Boilerplate**: Fluent builder API handles all registration automatically
- **No `.build()` Required**: Builder implements the plugin interface directly
- **IDE Support**: Autocomplete, go-to-definition, and refactoring work seamlessly

## Quick Start

### 1. Create a Plugin

```typescript
// features/tracking/plugin.ts
import { definePlugin } from '@arki/dot';

import { authPlugin } from '../auth/plugin';
import { contentPlugin } from '../content/plugin';

import { trackingRouter } from './router';
import { createTrackingRepositories } from './repositories';
import * as schema from './schema';
import { trackingProjection } from './projections';
import { trackingCommandHandlers } from './domain/decider';

export const trackingPlugin = definePlugin('tracking')
  .dependsOn(authPlugin, contentPlugin)  // Type-safe plugin references!
  .router(trackingRouter)                // Name defaults to 'tracking'
  .schema(schema)
  .repository(createTrackingRepositories) // Name defaults to 'tracking'
  .projections(trackingProjection)
  .commands(...trackingCommandHandlers)
  .withMetadata({
    version: '1.0.0',
    description: 'User tracking and engagement features',
  });
```

### 2. Register Plugins in Bootstrap

```typescript
// bootstrap.ts
import { createDot } from '@arki/dot';
import { authPlugin } from './features/auth/plugin';
import { trackingPlugin } from './features/tracking/plugin';
import { socialPlugin } from './features/social/plugin';

export const app = await createDot('my-app')
  .withEnv(env)
  .withKv()
  .registerPlugins([
    authPlugin,
    trackingPlugin,
    socialPlugin,
  ])
  .bootstrap();

export type AppRouter = typeof app.router;
```

That's it! No more manual registration in multiple files.

## Plugin Builder API

The plugin builder provides a fluent API for constructing plugins:

### definePlugin(name)

Creates a new plugin builder:

```typescript
export const myPlugin = definePlugin('my-feature');
```

### .dependsOn(...plugins)

Declares dependencies on other plugins (type-safe!):

```typescript
import { authPlugin } from '../auth/plugin';
import { contentPlugin } from '../content/plugin';

export const trackingPlugin = definePlugin('tracking')
  .dependsOn(authPlugin, contentPlugin);
```

**Benefits:**
- ✅ Type-safe: You import actual plugin objects, not strings
- ✅ IDE support: Autocomplete and go-to-definition work
- ✅ Refactoring: Renaming a plugin updates all references automatically

### .router(router) / .router(name, router)

Registers a tRPC router. If name is omitted, uses the plugin name:

```typescript
// Registers as 'tracking'
.router(trackingRouter)

// Registers as 'tracking.movies'
.router('tracking.movies', moviesRouter)
```

### .schema(schema)

Registers database schema definitions:

```typescript
import * as schema from './schema';

.schema(schema)
```

### .repository(factory) / .repository(name, factory)

Registers a repository factory. If name is omitted, uses the plugin name:

```typescript
// Registers as 'tracking'
.repository(createTrackingRepositories)

// Registers as 'tracking.movies'
.repository('tracking.movies', createMoviesRepository)
```

### .projections(...projections)

Registers event sourcing projections:

```typescript
.projections(trackingProjection, analyticsProjection)
```

### .commands(...handlers)

Registers command handlers:

```typescript
.commands(...trackingCommandHandlers)
```

### .jobs(jobs)

Registers background jobs:

```typescript
.jobs({
  syncMovies,
  calculateStats,
})
```

### .processManager(pm)

Registers a process manager (saga):

```typescript
.processManager(notificationProcessManager)
```

### .withMetadata(metadata)

Sets plugin metadata:

```typescript
.withMetadata({
  version: '1.0.0',
  description: 'Tracking features',
  author: 'Your Team',
})
```

## Plugin Interface

### PluginConfig

The builder implements the `PluginConfig` interface directly (no `.build()` needed):

```typescript
interface PluginConfig<
  TSchema extends SchemaInterface = SchemaInterface,
  TName extends string = string
> {
  /** Unique identifier for this plugin (typed as literal) */
  name: TName;

  /** Setup function called during bootstrap */
  setup: (context: PluginContext<TSchema>) => void | Promise<void>;

  /** Optional: Plugin dependencies (load order) */
  dependencies?: string[];

  /** Optional: Plugin metadata */
  metadata?: {
    version?: string;
    description?: string;
    author?: string;
  };
}
```

**Type Parameters:**
- `TSchema`: The database schema type (defaults to `SchemaInterface`)
- `TName`: The plugin name as a **literal type** (defaults to `string`)

### PluginContext

The `PluginContext` provides methods to register your plugin's components:

```typescript
interface PluginContext<TSchema extends SchemaInterface = SchemaInterface> {
  /** Register a tRPC router */
  registerRouter: (name: string, router: AnyRouter) => void;

  /** Register database schema definitions */
  registerSchema: (schema: Record<string, unknown>) => void;

  /** Register a repository factory function */
  registerRepository: (name: string, factory: RepositoryFactory) => void;

  /** Register event sourcing projections */
  registerProjections: (...projections: BaseProjectionDefinition[]) => void;

  /** Register command handlers for the message bus */
  registerCommands: (...handlers: CommandHandlerRegistration[]) => void;

  /** Optional: Register background jobs */
  registerJobs?: (jobs: Record<string, unknown>) => void;

  /** Optional: Register process managers (saga patterns) */
  registerProcessManager?: (pm: unknown) => void;

  /** Access to initialized services (available during late-stage setup) */
  services?: {
    db?: NodePgDatabase<TSchema>;
    kv?: KV;
    eventStore?: EventStore;
    messageBus?: MessageBus;
  };
}
```

## Plugin Dependencies

### Type-Safe Dependencies

Plugins can declare dependencies on other plugins using actual plugin instances:

```typescript
import { authPlugin } from '../auth/plugin';
import { socialPlugin } from '../social/plugin';
import { trackingPlugin } from '../tracking/plugin';

export const feedPlugin = definePlugin('feed')
  .dependsOn(authPlugin, socialPlugin, trackingPlugin)  // Type-safe!
  .router(feedRouter)
  .schema(schema);
```

**Why this is better than strings:**

```typescript
// ❌ Old way: String-based (error-prone)
dependencies: ['auth', 'social', 'tracking']

// ✅ New way: Plugin references (type-safe)
.dependsOn(authPlugin, socialPlugin, trackingPlugin)
```

Benefits:
- **Type Safety**: TypeScript ensures the plugins exist
- **IDE Support**: Autocomplete, go-to-definition, find-references
- **Refactoring**: Renaming a plugin updates all references
- **Import Checking**: Circular dependencies are caught at compile time

### Dependency Resolution

- Plugins are loaded in **topological order** based on dependencies
- **Circular dependencies** are detected and throw an error
- **Missing dependencies** throw an error at initialization

## Advanced Patterns

### Conditional Registration

```typescript
export const analyticsPlugin = definePlugin('analytics')
  .router(analyticsRouter);

// Setup function still has access to services for conditional logic
// if needed via the generated setup getter
```

### Plugin with Jobs

```typescript
export const contentPlugin = definePlugin('content')
  .router(contentRouter)
  .jobs({
    syncMovies: syncMoviesJob,
    refreshMetadata: refreshMetadataJob,
  });
```

### Multiple Routers or Repositories

```typescript
export const contentPlugin = definePlugin('content')
  .router('content', contentRouter)           // Main router
  .router('content.movies', moviesRouter)     // Sub-router
  .router('content.tv', tvShowsRouter)        // Sub-router
  .repository('content', createContentRepos)  // Main repos
  .repository('content.cache', createCacheRepo); // Additional repo
```

## Migration Guide

### Before (createPlugin factory)

```typescript
import { createPlugin } from '@arki/dot';

export const trackingPlugin = createPlugin({
  name: 'tracking',
  dependencies: ['auth', 'content'],  // String-based

  setup: ({
    registerRouter,
    registerSchema,
    registerRepository,
    registerProjections,
    registerCommands
  }) => {
    registerRouter('tracking', trackingRouter);
    registerSchema(schema);
    registerRepository('tracking', createTrackingRepositories);
    registerProjections(trackingProjection);
    registerCommands(...trackingCommandHandlers);
  },

  metadata: {
    version: '1.0.0',
    description: 'User tracking and engagement features',
  },
});
```

### After (definePlugin builder)

```typescript
import { definePlugin } from '@arki/dot';
import { authPlugin } from '../auth/plugin';
import { contentPlugin } from '../content/plugin';

export const trackingPlugin = definePlugin('tracking')
  .dependsOn(authPlugin, contentPlugin)  // Type-safe plugin references!
  .router(trackingRouter)                // Name defaults to 'tracking'
  .schema(schema)
  .repository(createTrackingRepositories) // Name defaults to 'tracking'
  .projections(trackingProjection)
  .commands(...trackingCommandHandlers)
  .withMetadata({
    version: '1.0.0',
    description: 'User tracking and engagement features',
  });
```

**Key Changes:**
1. Use `definePlugin(name)` instead of `createPlugin({ name })`
2. Use fluent builder methods (`.router()`, `.schema()`, etc.)
3. Use `.dependsOn(plugin, ...)` with actual plugin instances
4. Names default to plugin name for `.router()` and `.repository()`
5. Use `.withMetadata()` instead of `metadata` property
6. No explicit `setup` function - the builder generates it automatically

## Best Practices

### 1. One Plugin Per Feature

Each feature should have exactly one plugin that registers all its components:

```
features/
  tracking/
    plugin.ts           ← Single plugin file
    router.ts
    repositories.ts
    schema.ts
    projections.ts
```

### 2. Type-Safe Dependencies

Always use plugin references, not strings:

```typescript
import { authPlugin } from '../auth/plugin';

export const trackingPlugin = definePlugin('tracking')
  .dependsOn(authPlugin);  // ✅ Type-safe!
```

### 3. Default Naming

Let the builder use default names when possible:

```typescript
// ✅ Good: Uses plugin name
.router(trackingRouter)
.repository(createTrackingRepositories)

// ⚠️  Only use explicit names for sub-routers/repos
.router('tracking.movies', moviesRouter)
```

### 4. Descriptive Metadata

Include version and description for better documentation:

```typescript
.withMetadata({
  version: '1.0.0',
  description: 'User tracking and engagement features',
})
```

### 5. Method Chaining

The builder is designed for method chaining:

```typescript
export const myPlugin = definePlugin('my-feature')
  .dependsOn(dep1, dep2)
  .router(router)
  .schema(schema)
  .repository(repos)
  .projections(projection)
  .commands(...handlers)
  .withMetadata(metadata);
```

## Troubleshooting

### Circular Dependency Error

```
Error: Circular dependency detected for plugin "feed"
```

**Solution**: Check your plugin dependencies - plugin A depends on B, which depends on A. TypeScript should catch this at compile time if you're using plugin references!

### Missing Plugin Error

```
Error: Plugin "auth" not found (required as dependency)
```

**Solution**: Make sure all required plugins are included in `registerPlugins()`.

### Duplicate Router Error

```
Error: Router "tracking" is already registered
```

**Solution**: You're registering the same router twice. Check for duplicate plugin registration or use explicit names for sub-routers.

### TypeScript Error: Cannot find module

```
Error: Cannot find module '@arki/dot' or its corresponding type declarations
```

**Solution**: Make sure you've updated your imports from `createPlugin` to `definePlugin`.

## Type Safety

The plugin system is fully type-safe with advanced type inference:

### Plugin Name Type Inference

The plugin name is captured as a **literal type** throughout the entire system:

```typescript
// TypeScript infers: PluginBuilder<SchemaInterface, "auth">
export const authPlugin = definePlugin('auth')
  .router(authRouter)
  .schema(schema);

// TypeScript infers: PluginBuilder<SchemaInterface, "tracking">
export const trackingPlugin = definePlugin('tracking')
  .dependsOn(authPlugin)  // TypeScript knows authPlugin.name is "auth"
  .router(trackingRouter);
```

**Benefits of Literal Type Inference:**

1. **IDE Autocomplete**: Your IDE knows the exact plugin names
   ```typescript
   // Autocomplete shows: "auth", "tracking", "social", etc.
   .dependsOn(authPlugin, trackingPlugin)
   ```

2. **Compile-Time Validation**: TypeScript catches errors before runtime
   ```typescript
   // ✅ Valid: authPlugin is correctly typed
   .dependsOn(authPlugin)

   // ❌ Error: TypeScript catches non-plugin objects
   .dependsOn("auth")  // Type error!
   ```

3. **Refactoring Safety**: Renaming a plugin updates all references
   ```typescript
   // Change definePlugin('tracking') to definePlugin('user-tracking')
   // TypeScript will show errors everywhere 'tracking' is referenced
   ```

4. **Type-Safe Plugin Registry**: The registry knows the exact plugin names
   ```typescript
   // The type system tracks which plugins are registered
   export const app = await createDot('my-app')
     .registerPlugins([
       authPlugin,      // Type: PluginBuilder<SchemaInterface, "auth">
       trackingPlugin,  // Type: PluginBuilder<SchemaInterface, "tracking">
     ])
     .bootstrap();
   ```

### Full Type Safety Features

```typescript
// ✅ Type-safe plugin references
.dependsOn(authPlugin, contentPlugin)

// ✅ Type-safe router registration
.router(trackingRouter)

// ✅ Type-safe repository registration
.repository(createTrackingRepositories)

// ✅ Type inference works throughout
export const app = await createDot('my-app')
  .registerPlugins([...])
  .bootstrap();

type AppRouter = typeof app.router; // Fully typed!
```

## Testing Plugins

```typescript
import { createDot } from '@arki/dot';
import { trackingPlugin } from './plugin';

describe('tracking plugin', () => {
  it('should register all components', async () => {
    const app = await createDot('test')
      .withEnv(testEnv)
      .registerPlugins([trackingPlugin])
      .bootstrap();

    expect(app.router.tracking).toBeDefined();
    expect(app.repositories.tracking).toBeDefined();
  });
});
```

## Summary

The builder pattern transforms plugin creation from:

```typescript
// Old: Factory with setup function
export const trackingPlugin = createPlugin({
  name: 'tracking',
  dependencies: ['auth'],  // Strings
  setup: (context) => {
    context.registerRouter('tracking', trackingRouter);
    context.registerRepository('tracking', createTrackingRepositories);
    // ...
  },
});
```

Into:

```typescript
// New: Fluent builder with type-safe dependencies
export const trackingPlugin = definePlugin('tracking')
  .dependsOn(authPlugin)  // Type-safe!
  .router(trackingRouter)  // Defaults to 'tracking'
  .repository(createTrackingRepositories)
  .projections(projection)
  .commands(...handlers);
```

Clean, simple, type-safe, and maintainable! 🎉
