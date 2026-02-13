/**
 * Factory System for Test Data Generation
 *
 * Provides a flexible factory pattern supporting both function and builder APIs:
 * - Function pattern: `factory({ field: 'value' })`
 * - Builder pattern: `factory().with('field', 'value').build()`
 *
 * Integrates with @faker-js/faker for realistic test data generation.
 *
 * @example
 * ```typescript
 * import { createFactory } from '@arki/testing';
 * import { faker } from '@faker-js/faker';
 *
 * // Define a factory
 * const userFactory = createFactory<User>(() => ({
 *   id: createUserId(),
 *   email: faker.internet.email(),
 *   name: faker.person.fullName(),
 *   createdAt: faker.date.past(),
 *   updatedAt: new Date(),
 * }));
 *
 * // Use function pattern
 * const user1 = userFactory({ email: 'test@example.com' });
 *
 * // Use builder pattern
 * const user2 = userFactory()
 *   .with('email', 'admin@example.com')
 *   .with('name', 'Admin User')
 *   .build();
 * ```
 */



import { debugFactories } from './debug';

/**
 * Factory builder for creating test data with a fluent API
 */
export class FactoryBuilder<T> {
  private overrides: Partial<T> = {};

  constructor(private generator: () => T) {}

  /**
   * Set a field value
   */
  with<K extends keyof T>(field: K, value: T[K]): this {
    this.overrides[field] = value;
    return this;
  }

  /**
   * Set multiple field values
   */
  withMany(values: Partial<T>): this {
    Object.assign(this.overrides, values);
    return this;
  }

  /**
   * Build the final object
   */
  build(): T {
    return {
      ...this.generator(),
      ...this.overrides,
    };
  }
}

/**
 * Factory function that supports both direct call and builder pattern
 */
export type Factory<T> = {
  /**
   * Create instance with overrides (function pattern)
   */
  (overrides?: Partial<T>): T;

  /**
   * Start builder chain (builder pattern)
   */
  (): FactoryBuilder<T>;
}

/**
 * Create a factory function with dual API support
 *
 * @param generator - Function that generates the base object
 * @param defaults - Optional default values to merge
 * @returns Factory function supporting both patterns
 *
 * @example
 * ```typescript
 * const gameFactory = createFactory<Game>(() => ({
 *   id: createGameId(),
 *   name: faker.word.words(2),
 *   slug: faker.helpers.slugify(faker.word.words(2)),
 *   status: 'active',
 *   createdAt: faker.date.past(),
 *   updatedAt: new Date(),
 * }));
 *
 * // Function pattern
 * const game1 = gameFactory({ name: 'Chess' });
 *
 * // Builder pattern
 * const game2 = gameFactory()
 *   .with('name', 'Sudoku')
 *   .with('status', 'draft')
 *   .build();
 * ```
 */
export function createFactory<T>(generator: () => T, defaults?: Partial<T>): Factory<T> {
  const factory = (overridesOrNothing?: Partial<T>): T | FactoryBuilder<T> => {
    // If called with no arguments, return builder
    if (overridesOrNothing === undefined && arguments.length === 0) {
      return new FactoryBuilder<T>(() => ({
        ...generator(),
        ...defaults,
      }));
    }

    // If called with arguments (even undefined), use function pattern
    return {
      ...generator(),
      ...defaults,
      ...overridesOrNothing,
    };
  };

  return factory as Factory<T>;
}

/**
 * Create multiple instances from a factory
 *
 * @param factory - Factory function to use
 * @param count - Number of instances to create
 * @param overrides - Optional overrides for all instances or function to generate per-instance overrides
 * @returns Array of instances
 *
 * @example
 * ```typescript
 * // Create 5 games with same overrides
 * const games = createMany(gameFactory, 5, { status: 'active' });
 *
 * // Create 5 games with different scores
 * const games = createMany(gameFactory, 5, (index) => ({
 *   score: 100 * (index + 1)
 * }));
 * ```
 */
export function createMany<T>(
  factory: Factory<T>,
  count: number,
  overrides?: Partial<T> | ((index: number) => Partial<T>),
): T[] {
  return Array.from({ length: count }, (_, index) => {
    const instanceOverrides = typeof overrides === 'function' ? overrides(index) : overrides;
    return factory(instanceOverrides);
  });
}

/**
 * Create a sequence of instances with specific field values
 *
 * @param factory - Factory function to use
 * @param field - Field to set with sequence values
 * @param values - Array of values to use for the field
 * @param baseOverrides - Optional overrides for all instances
 * @returns Array of instances
 *
 * @example
 * ```typescript
 * // Create sessions with specific scores
 * const sessions = createSequence(
 *   sessionFactory,
 *   'score',
 *   [100, 200, 300, 400, 500]
 * );
 *
 * // Create sessions with specific timestamps
 * const sessions = createSequence(
 *   sessionFactory,
 *   'createdAt',
 *   [new Date('2024-01-01'), new Date('2024-01-02')],
 *   { status: 'completed' }
 * );
 * ```
 */
export function createSequence<T, K extends keyof T>(
  factory: Factory<T>,
  field: K,
  values: T[K][],
  baseOverrides?: Partial<T>,
): T[] {
  return values.map(value =>
    factory({
      ...baseOverrides,
      [field]: value,
    } as Partial<T>),
  );
}

/**
 * Factory registry for managing multiple factories
 *
 * @example
 * ```typescript
 * const registry = new FactoryRegistry();
 *
 * registry.register('user', userFactory);
 * registry.register('game', gameFactory);
 * registry.register('session', sessionFactory);
 *
 * // Use factories
 * const user = registry.create('user', { email: 'test@example.com' });
 * const game = registry.create('game');
 *
 * // Create many
 * const users = registry.createMany('user', 5);
 * ```
 */
export class FactoryRegistry {
  private factories = new Map<string, Factory<any>>();

  /**
   * Register a factory
   */
  register<T>(name: string, factory: Factory<T>): void {
    debugFactories('[factories] Registering factory (name: %s)', name);
    this.factories.set(name, factory);
  }

  /**
   * Check if a factory is registered
   */
  has(name: string): boolean {
    const exists = this.factories.has(name);
    debugFactories('[factories] Checking factory exists (name: %s, exists: %s)', name, exists);
    return exists;
  }

  /**
   * Get a registered factory
   */
  get<T>(name: string): Factory<T> | undefined {
    const factory = this.factories.get(name);
    debugFactories('[factories] Getting factory (name: %s, found: %s)', name, !!factory);
    return factory;
  }

  /**
   * Create an instance using a registered factory
   */
  create<T>(name: string, overrides?: Partial<T>): T {
    debugFactories('[factories] Creating instance (name: %s, hasOverrides: %s)', name, !!overrides);
    const factory = this.factories.get(name);
    if (!factory) {
      debugFactories('[factories] Factory not found: %s', name);
      throw new Error(`Factory '${name}' not registered`);
    }
    const instance = factory(overrides);
    debugFactories('[factories] Instance created (name: %s)', name);
    return instance;
  }

  /**
   * Create multiple instances using a registered factory
   */
  createMany<T>(name: string, count: number, overrides?: Partial<T> | ((index: number) => Partial<T>)): T[] {
    debugFactories('[factories] Creating multiple instances (name: %s, count: %d)', name, count);
    const factory = this.factories.get(name);
    if (!factory) {
      debugFactories('[factories] Factory not found: %s', name);
      throw new Error(`Factory '${name}' not registered`);
    }
    const instances = createMany(factory, count, overrides);
    debugFactories('[factories] %d instances created (name: %s)', instances.length, name);
    return instances;
  }

  /**
   * Clear all registered factories
   */
  clear(): void {
    const count = this.factories.size;
    debugFactories('[factories] Clearing all factories (count: %d)', count);
    this.factories.clear();
    debugFactories('[factories] All factories cleared');
  }
}

/**
 * Type-safe factory registry with full type inference
 *
 * Supports nested factory structures with complete TypeScript autocomplete.
 * Inspired by tRPC's type inference patterns.
 *
 * @example
 * ```typescript
 * // Define feature-specific factories
 * const userFactories = {
 *   user: createFactory<User>(() => ({ id: '1', name: 'John' })),
 *   profile: createFactory<Profile>(() => ({ userId: '1', bio: 'Hello' })),
 * } as const;
 *
 * const postFactories = {
 *   post: createFactory<Post>(() => ({ id: '1', title: 'Hello' })),
 * } as const;
 *
 * // Merge into typed registry
 * const factories = {
 *   user: userFactories,
 *   post: postFactories,
 * } as const;
 *
 * const registry = new TypedFactoryRegistry(factories);
 *
 * // Full type inference and autocomplete!
 * const user = registry.user.user({ name: 'Jane' }); // Type: User
 * const post = registry.post.post({ title: 'World' }); // Type: Post
 * ```
 */
export class TypedFactoryRegistry<
  TFactories extends Record<string, Record<string, Factory<any>>>,
> extends FactoryRegistry {
  [K: string]: any;

  constructor(typedFactories: TFactories) {
    super();
    // Expose typed factories as properties for direct access
    for (const [namespace, factories] of Object.entries(typedFactories)) {
      (this as any)[namespace] = factories;
    }
  }
}

// Helper type to merge FactoryRegistry base with TFactories
export type TypedFactoryRegistryInstance<TFactories extends Record<string, Record<string, Factory<any>>>> =
  TypedFactoryRegistry<TFactories> & TFactories;

/**
 * Helper type to extract the return type of a factory
 */
export type FactoryOutput<T extends Factory<any>> = ReturnType<T>;

/**
 * Helper type to extract all factory outputs from a factories object
 */
export type FactoriesOutput<T extends Record<string, Factory<any>>> = {
  [K in keyof T]: FactoryOutput<T[K]>;
};

/**
 * Create a typed factory registry with full type inference
 *
 * Following tRPC's createTRPCRouter pattern - automatically infers types
 * from the factory object structure without needing explicit type parameters.
 *
 * @param factories - Object containing factory functions
 * @returns Typed factory registry with full autocomplete
 *
 * @example
 * ```typescript
 * // Define factories with createFactory
 * const gameFactory = createFactory<Game>(() => ({
 *   id: createGameId(),
 *   name: faker.word.words(2),
 * }));
 *
 * const gameModeFactory = createFactory<GameMode>(() => ({
 *   id: createGameModeId(),
 *   name: faker.word.word(),
 * }));
 *
 * // Create registry - types are automatically inferred!
 * const gameRegistryFactories = createFactories({
 *   game: gameFactory,
 *   gameMode: gameModeFactory,
 * });
 *
 * // Full type inference and autocomplete
 * const game = gameRegistryFactories.game({ name: 'Chess' }); // Type: Game
 * const mode = gameRegistryFactories.gameMode(); // Type: GameMode
 * ```
 */
export function createFactories<TFactories extends Record<string, Factory<any> | Record<string, any>>>(
  factories: TFactories,
): TFactories {
  return factories;
}

/**
 * Export faker instance for convenience
 */


export {faker} from '@faker-js/faker';