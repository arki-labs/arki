import { LifecycleManager } from './lifecycle';
import { ServiceMetricsCollector } from './metrics';
import { SingletonServicesRegistry } from './singleton-registry';

/**
 * Base context builder for two-tier architecture
 * Separates expensive singleton services from cheap request-scoped context
 *
 * @example
 * ```typescript
 * // Define your service types
 * type AppServices = {
 *   db: Database;
 *   kv: KVStore;
 *   messageBus: MessageBus;
 * };
 *
 * type RequestContext = {
 *   executionType: ExecutionContextType;
 *   repo: Repositories;
 *   services: AppServices;
 * };
 *
 * // Create builder
 * const builder = new BaseContextBuilder<AppServices, RequestContext>();
 *
 * // Register singletons
 * await builder.initializeSingletons(async (registry) => {
 *   registry.register('db', await createDatabase());
 *   registry.register('kv', await createKVStore());
 *   registry.register('messageBus', createMessageBus());
 * });
 *
 * // Create request contexts
 * const ctx = builder.createContext((services) => ({
 *   executionType: 'rpc',
 *   repo: createRepositories(services.db),
 *   services,
 * }));
 * ```
 */
export class BaseContextBuilder<
  TSingletons extends Record<string, unknown>,
  TContext extends Record<string, unknown>,
> {
  private readonly singletonsRegistry: SingletonServicesRegistry<TSingletons>;
  private readonly lifecycleManager: LifecycleManager;
  private readonly metricsCollector: ServiceMetricsCollector | null;
  private initialized = false;
  private contextFactory: ((singletons: TSingletons) => TContext) | null = null;

  constructor(
    singletonsRegistry: SingletonServicesRegistry<TSingletons>,
    lifecycleManager: LifecycleManager,
    metricsCollector: ServiceMetricsCollector | null = null
  ) {
    this.singletonsRegistry = singletonsRegistry;
    this.lifecycleManager = lifecycleManager;
    this.metricsCollector = metricsCollector;
  }

  /**
   * Initialize singleton services
   * Should be called once during application startup
   */
  async initializeSingletons(
    initializer: (registry: SingletonServicesRegistry<TSingletons>) => Promise<void> | void
  ): Promise<void> {
    if (this.initialized) {
      throw new Error('Singletons already initialized');
    }

    const startTime = Date.now();

    await initializer(this.singletonsRegistry);

    // Track initialization metrics if enabled
    if (this.metricsCollector) {
      const services = this.singletonsRegistry.getAll();
      for (const [name, service] of Object.entries(services)) {
        if (service) {
          const metrics = this.singletonsRegistry.getMetrics(name as keyof TSingletons);
          this.metricsCollector.record({
            name,
            initTimeMs: metrics.initElapsedMs,
            accessCount: 0,
            ageMs: null,
            initialized: true,
          });
        }
      }
    }

    this.initialized = true;

    // Register shutdown handler
    this.lifecycleManager.onShutdown(async () => {
      const results = await this.singletonsRegistry.dispose();
      const failures = results.filter(r => !r.success);

      if (failures.length > 0) {
        console.error(
          `Service disposal completed with ${failures.length} error(s):`,
          failures.map(f => `${f.key}: ${f.error?.message}`).join(', ')
        );
      }
    });

    console.log(`Singleton services initialized in ${Date.now() - startTime}ms`);
  }

  /**
   * Set the context factory function
   * This function creates request-scoped context from singletons
   */
  setContextFactory(factory: (singletons: TSingletons) => TContext): void {
    this.contextFactory = factory;
  }

  /**
   * Create a request-scoped context
   * Reuses singleton services and creates fresh request-scoped resources
   */
  createContext(): TContext {
    if (!this.initialized) {
      throw new Error(
        'Cannot create context: Singletons not initialized.\n' +
        'Call builder.initializeSingletons() during application startup.\n' +
        'See: packages/dot/src/context/README.md#basecontextbuilder'
      );
    }

    if (!this.contextFactory) {
      throw new Error(
        'Cannot create context: Context factory not set.\n' +
        'Call builder.setContextFactory() to define how contexts are created.\n' +
        'Example: builder.setContextFactory(services => ({ ...services, repo: createRepos(services.db) }))'
      );
    }

    const singletons = this.singletonsRegistry.getAll();

    // Validate all expected singletons are present
    const allKeys = Object.keys(singletons);
    if (allKeys.length === 0) {
      throw new Error(
        'Cannot create context: No singletons registered.\n' +
        'Register services using registry.register() inside initializeSingletons()'
      );
    }

    // Track singleton access if metrics enabled
    if (this.metricsCollector) {
      for (const key of allKeys) {
        this.metricsCollector.incrementAccess(key);
      }
    }

    return this.contextFactory(singletons as TSingletons);
  }

  /**
   * Get the singleton registry
   */
  getSingletons(): Partial<TSingletons> {
    return this.singletonsRegistry.getAll();
  }

  /**
   * Get the lifecycle manager
   */
  getLifecycleManager(): LifecycleManager {
    return this.lifecycleManager;
  }

  /**
   * Get the metrics collector
   * Returns null if metrics are disabled
   */
  getMetricsCollector(): ServiceMetricsCollector | null {
    return this.metricsCollector;
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  setupGracefulShutdown(exitOnComplete = true): void {
    this.lifecycleManager.setupSignalHandlers(exitOnComplete);
  }

  /**
   * Manually trigger shutdown
   */
  async shutdown(): Promise<void> {
    await this.lifecycleManager.shutdown();
  }
}

/**
 * Create a new base context builder with default instances
 * @param enableMetrics - Whether to enable metrics collection (default: true)
 */
export function createBaseContextBuilder<
  TSingletons extends Record<string, unknown>,
  TContext extends Record<string, unknown>,
>(options?: { enableMetrics?: boolean }): BaseContextBuilder<TSingletons, TContext> {
  const enableMetrics = options?.enableMetrics ?? true;
  return new BaseContextBuilder(
    new SingletonServicesRegistry<TSingletons>(),
    new LifecycleManager(),
    enableMetrics ? new ServiceMetricsCollector() : null
  );
}
