import { debugContext } from '../debug.js';
import { LifecycleManager } from './lifecycle.js';
import { ServiceMetricsCollector } from './metrics.js';
import { SingletonServicesRegistry } from './singleton-registry.js';

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
export class BaseContextBuilder<TSingletons extends Record<string, unknown>, TContext extends Record<string, unknown>> {
  private readonly singletonsRegistry: SingletonServicesRegistry<TSingletons>;
  private readonly lifecycleManager: LifecycleManager;
  private readonly metricsCollector: ServiceMetricsCollector | null;
  private initialized = false;
  private contextFactory: ((singletons: TSingletons) => TContext) | null = null;

  constructor(
    singletonsRegistry: SingletonServicesRegistry<TSingletons>,
    lifecycleManager: LifecycleManager,
    metricsCollector: ServiceMetricsCollector | null = null,
  ) {
    this.singletonsRegistry = singletonsRegistry;
    this.lifecycleManager = lifecycleManager;
    this.metricsCollector = metricsCollector;
    debugContext('[BaseContextBuilder] Constructor initialized (metricsEnabled: %s)', !!metricsCollector);
  }

  /**
   * Initialize singleton services
   * Should be called once during application startup
   */
  async initializeSingletons(
    initializer: (registry: SingletonServicesRegistry<TSingletons>) => Promise<void> | void,
  ): Promise<void> {
    if (this.initialized) {
      debugContext('[BaseContextBuilder] initializeSingletons called but already initialized, throwing error');
      throw new Error('Singletons already initialized');
    }

    debugContext('[BaseContextBuilder] Starting singleton services initialization');
    const startTime = Date.now();

    await initializer(this.singletonsRegistry);

    // Track initialization metrics if enabled
    if (this.metricsCollector) {
      const services = this.singletonsRegistry.getAll();
      const serviceCount = Object.keys(services).length;
      debugContext('[BaseContextBuilder] Recording metrics for %d services', serviceCount);
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
          debugContext(
            '[BaseContextBuilder] Metrics recorded for service: %s (initTime: %dms)',
            name,
            metrics.initElapsedMs,
          );
        }
      }
    }

    this.initialized = true;

    // Register shutdown handler
    this.lifecycleManager.onShutdown(async () => {
      debugContext('[BaseContextBuilder] Shutdown initiated, disposing singletons');
      const results = await this.singletonsRegistry.dispose();
      const failures = results.filter(r => !r.success);

      if (failures.length > 0) {
        debugContext('[BaseContextBuilder] Service disposal completed with %d error(s)', failures.length);
        console.error(
          `Service disposal completed with ${failures.length} error(s):`,
          failures.map(f => `${f.key}: ${f.error?.message}`).join(', '),
        );
      } else {
        debugContext('[BaseContextBuilder] All services disposed successfully');
      }
    });

    const elapsedMs = Date.now() - startTime;
    debugContext('[BaseContextBuilder] Singleton services initialized in %dms', elapsedMs);
  }

  /**
   * Set the context factory function
   * This function creates request-scoped context from singletons
   */
  setContextFactory(factory: (singletons: TSingletons) => TContext): void {
    debugContext('[BaseContextBuilder] Context factory set');
    this.contextFactory = factory;
  }

  /**
   * Create a request-scoped context
   * Reuses singleton services and creates fresh request-scoped resources
   */
  createContext(): TContext {
    if (!this.initialized) {
      debugContext('[BaseContextBuilder] Cannot create context: Singletons not initialized');
      throw new Error(
        'Cannot create context: Singletons not initialized.\n' +
          'Call builder.initializeSingletons() during application startup.\n' +
          'See: packages/dot/src/context/README.md#basecontextbuilder',
      );
    }

    if (!this.contextFactory) {
      debugContext('[BaseContextBuilder] Cannot create context: Context factory not set');
      throw new Error(
        'Cannot create context: Context factory not set.\n' +
          'Call builder.setContextFactory() to define how contexts are created.\n' +
          'Example: builder.setContextFactory(services => ({ ...services, repo: createRepos(services.db) }))',
      );
    }

    const singletons = this.singletonsRegistry.getAll();

    // Validate all expected singletons are present
    const allKeys = Object.keys(singletons);
    if (allKeys.length === 0) {
      debugContext('[BaseContextBuilder] Cannot create context: No singletons registered');
      throw new Error(
        'Cannot create context: No singletons registered.\n' +
          'Register services using registry.register() inside initializeSingletons()',
      );
    }

    debugContext('[BaseContextBuilder] Creating context with %d singleton(s)', allKeys.length);

    // Track singleton access if metrics enabled
    if (this.metricsCollector) {
      for (const key of allKeys) {
        this.metricsCollector.incrementAccess(key);
      }
      debugContext('[BaseContextBuilder] Incremented access count for %d singleton(s)', allKeys.length);
    }

    return this.contextFactory(singletons as TSingletons);
  }

  /**
   * Get the singleton registry
   */
  getSingletons(): Partial<TSingletons> {
    const singletons = this.singletonsRegistry.getAll();
    const count = Object.keys(singletons).length;
    debugContext('[BaseContextBuilder] Getting %d singleton(s)', count);
    return singletons;
  }

  /**
   * Get the lifecycle manager
   */
  getLifecycleManager(): LifecycleManager {
    debugContext('[BaseContextBuilder] Getting lifecycle manager');
    return this.lifecycleManager;
  }

  /**
   * Get the metrics collector
   * Returns null if metrics are disabled
   */
  getMetricsCollector(): ServiceMetricsCollector | null {
    debugContext('[BaseContextBuilder] Getting metrics collector (enabled: %s)', !!this.metricsCollector);
    return this.metricsCollector;
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  setupGracefulShutdown(exitOnComplete = true): void {
    debugContext('[BaseContextBuilder] Setting up graceful shutdown (exitOnComplete: %s)', exitOnComplete);
    this.lifecycleManager.setupSignalHandlers(exitOnComplete);
  }

  /**
   * Manually trigger shutdown
   */
  async shutdown(): Promise<void> {
    debugContext('[BaseContextBuilder] Manual shutdown triggered');
    await this.lifecycleManager.shutdown();
    debugContext('[BaseContextBuilder] Manual shutdown completed');
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
  debugContext('[createBaseContextBuilder] Creating new context builder (metricsEnabled: %s)', enableMetrics);
  return new BaseContextBuilder(
    new SingletonServicesRegistry<TSingletons>(),
    new LifecycleManager(),
    enableMetrics ? new ServiceMetricsCollector() : null,
  );
}
