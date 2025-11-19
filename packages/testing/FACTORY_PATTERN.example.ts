/**
 * Factory Type Safety Pattern Documentation
 *
 * This file demonstrates the type-safe factory pattern implemented in @arki/testing
 * and how to use it across applications.
 */

import { createFactory, TypedFactoryRegistry } from '@arki/testing';

// ============================================================================
// Step 1: Define Feature-Specific Factories
// ============================================================================

/**
 * Each feature defines its own factories in __tests__/factories.ts
 *
 * Location: features/my-feature/__tests__/factories.ts
 */

// Example: User feature factories
interface User {
  id: string;
  name: string;
  email: string;
}

interface Profile {
  userId: string;
  bio: string;
  avatar: string | null;
}

const userFactory = createFactory<User>(() => ({
  id: `usr_${Math.random().toString(36).substr(2, 9)}`,
  name: 'Test User',
  email: 'test@example.com',
}));

const profileFactory = createFactory<Profile>(() => ({
  userId: `usr_${Math.random().toString(36).substr(2, 9)}`,
  bio: 'Hello World',
  avatar: null,
}));

// Export as const for type inference
export const userFactories = {
  user: userFactory,
  profile: profileFactory,
} as const;

// Example: Post feature factories
interface Post {
  id: string;
  title: string;
  content: string;
  authorId: string;
}

const postFactory = createFactory<Post>(() => ({
  id: `post_${Math.random().toString(36).substr(2, 9)}`,
  title: 'Test Post',
  content: 'Lorem ipsum',
  authorId: `usr_${Math.random().toString(36).substr(2, 9)}`,
}));

export const postFactories = {
  post: postFactory,
} as const;

// ============================================================================
// Step 2: Merge Factories in Root Registry
// ============================================================================

/**
 * Merge all feature factories into a single typed object
 *
 * Location: core/__tests__/factories.ts
 */

const factoriesObject = {
  user: userFactories,
  post: postFactories,
} as const;

// Create typed registry with full type inference
export const factories = new TypedFactoryRegistry(factoriesObject);

// Export type for reference
export type AppFactories = typeof factoriesObject;
export type AppFactoryRegistry = typeof factories;

// ============================================================================
// Step 3: Use in Tests with Full Type Safety
// ============================================================================

/**
 * Example test demonstrating type-safe factory usage
 */
function exampleTest() {
  // ✅ Full autocomplete on namespace
  // factories.user.    <- Shows: user, profile
  // factories.post.    <- Shows: post

  // ✅ Full type inference on factory output
  const user = factories.user.user({ name: 'Alice' });
  //    ^? User (TypeScript infers the type automatically!)

  const profile = factories.user.profile({
    userId: user.id, // ✅ TypeScript knows user.id exists
    bio: 'Software Engineer',
  });
  //    ^? Profile

  const post = factories.post.post({
    title: 'My First Post',
    authorId: user.id, // ✅ Type-safe reference
  });
  //    ^? Post

  // ✅ TypeScript errors on invalid properties
  // const badUser = factories.user.user({
  //   invalidField: 'error' // ❌ TypeScript error!
  // });

  // ✅ TypeScript errors on invalid factories
  // const bad = factories.user.nonExistent(); // ❌ TypeScript error!

  console.log('User:', user);
  console.log('Profile:', profile);
  console.log('Post:', post);
}

// ============================================================================
// Key Benefits
// ============================================================================

/**
 * 1. Type Inference
 *    - No manual type annotations needed
 *    - TypeScript infers types from factory definitions
 *    - Uses ReturnType<typeof factory> pattern
 *
 * 2. Autocomplete
 *    - IDE shows all available feature namespaces
 *    - IDE shows all factories within each namespace
 *    - IDE shows all properties when using overrides
 *
 * 3. Compile-Time Safety
 *    - Invalid factory names cause TypeScript errors
 *    - Invalid properties in overrides cause TypeScript errors
 *    - Type mismatches caught at compile time
 *
 * 4. Feature Isolation
 *    - Each feature owns its factories
 *    - Matches application architecture patterns
 *    - Easy to add/remove features
 *
 * 5. Scalability
 *    - Adding new factories: just add to feature's factories object
 *    - Adding new features: just add to root merger
 *    - No breaking changes to existing code
 */

// ============================================================================
// Pattern Comparison with tRPC
// ============================================================================

/**
 * tRPC Pattern:
 *
 * 1. Define feature routers
 *    export const userRouter = router({ ... });
 *
 * 2. Merge routers
 *    export const appRouter = mergeRouters(userRouter, postRouter);
 *
 * 3. Create typed caller
 *    const caller = createCaller(appRouter);
 *    caller.user.getById({ id: '1' }); // ✅ Typed!
 *
 *
 * Factory Pattern (mirrors tRPC):
 *
 * 1. Define feature factories
 *    export const userFactories = { user: userFactory };
 *
 * 2. Merge factories
 *    export const factories = new TypedFactoryRegistry({ user: userFactories });
 *
 * 3. Use typed factories
 *    factories.user.user({ name: 'Alice' }); // ✅ Typed!
 */

// ============================================================================
// Migration Guide
// ============================================================================

/**
 * Old Pattern (String-based, no type safety):
 *
 * ```typescript
 * const game = tester.factory.create('game', { name: 'Chess' });
 * //                           ^^^^^  ^? any (no type inference!)
 * ```
 *
 * New Pattern (Nested, fully typed):
 *
 * ```typescript
 * const game = tester.factory.gameRegistry.game({ name: 'Chess' });
 * //                          ^^^^^^^^^^^^  ^^^^  ^? Game (full inference!)
 * ```
 *
 * Migration Steps:
 *
 * 1. Create feature factories files
 *    - features/my-feature/__tests__/factories.ts
 *    - Export const myFeatureFactories = { ... } as const
 *
 * 2. Update root factories.ts
 *    - Import all feature factories
 *    - Merge into factoriesObject
 *    - Create TypedFactoryRegistry
 *
 * 3. Update all test files
 *    - Replace: factory.create('name', {...})
 *    - With: factory.featureName.factoryName({...})
 *
 * 4. Verify TypeScript errors are resolved
 *    - Run: pnpm exec tsc --noEmit
 *    - All factory-related type errors should be gone
 */

// Run the example
exampleTest();
