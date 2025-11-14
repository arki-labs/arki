/* eslint-disable unicorn/prefer-switch */
/**
 * Generic singleton service registry for expensive-to-initialize services
 * Provides lifecycle management with registration, retrieval, and disposal
 */
export class SingletonServicesRegistry<TServices extends Record<string, unknown>> {
  private services: Partial<TServices> = {};
  private readonly initElapsedMs = new Map<keyof TServices, number>();
  private readonly accessCounts = new Map<keyof TServices, number>();
  private isDisposed = false;

  /**
   * Register a service in the singleton registry
   * @param key - Service identifier
   * @param service - Service instance
   * @param elapsedMs - Optional elapsed time in milliseconds for initialization
   */
  register<K extends keyof TServices>(
    key: K,
    service: TServices[K],
    elapsedMs?: number
  ): void {
    if (this.isDisposed) {
      throw new Error('Cannot register service: Registry has been disposed');
    }
    if (key in this.services) {
      throw new Error(`Service '${String(key)}' is already registered`);
    }
    this.services[key] = service;
    if (elapsedMs !== undefined) {
      this.initElapsedMs.set(key, elapsedMs);
    }
    this.accessCounts.set(key, 0);
  }

  /**
   * Register a service with automatic timing measurement
   * @param key - Service identifier
   * @param factory - Async factory function that creates the service
   */
  async registerWithTiming<K extends keyof TServices>(
    key: K,
    factory: () => Promise<TServices[K]> | TServices[K]
  ): Promise<void> {
    const startTime = performance.now();
    const service = await factory();
    const elapsedMs = performance.now() - startTime;
    this.register(key, service, elapsedMs);
  }

  /**
   * Get a registered service
   * @param key - Service identifier
   * @returns The service instance
   * @throws If service is not registered
   */
  get<K extends keyof TServices>(key: K): TServices[K] {
    if (this.isDisposed) {
      throw new Error('Cannot get service: Registry has been disposed');
    }
    if (!(key in this.services)) {
      throw new Error(`Service '${String(key)}' is not registered`);
    }

    // Track access for metrics
    const count = this.accessCounts.get(key) ?? 0;
    this.accessCounts.set(key, count + 1);

    return this.services[key] as TServices[K];
  }

  /**
   * Check if a service is registered
   * @param key - Service identifier
   */
  has<K extends keyof TServices>(key: K): boolean {
    return key in this.services;
  }

  /**
   * Get all registered services
   */
  getAll(): Partial<TServices> {
    return { ...this.services };
  }

  /**
   * Get service metrics
   * @param key - Service identifier
   */
  getMetrics<K extends keyof TServices>(key: K): {
    initElapsedMs: number | null;
    accessCount: number;
  } {
    const initElapsedMs = this.initElapsedMs.get(key) ?? null;
    const accessCount = this.accessCounts.get(key) ?? 0;

    return { initElapsedMs, accessCount };
  }

  /**
   * Clear all registered services without disposal
   * Useful for testing or hot reload scenarios
   */
  clear(): void {
    this.services = {};
    this.initElapsedMs.clear();
    this.accessCounts.clear();
  }

  /**
   * Dispose of all services that have a dispose/close/destroy method
   * Returns array of disposal results for error handling
   */
  async dispose(): Promise<{ key: string; success: boolean; error?: Error }[]> {
    const results: { key: string; success: boolean; error?: Error }[] = [];

    for (const [key, service] of Object.entries(this.services)) {
      if (!service) continue;

      try {
        // Try common disposal method names in priority order
        const disposable = service as {
          dispose?: () => unknown;
          close?: () => unknown;
          destroy?: () => unknown;
        };

        if (typeof disposable.dispose === 'function') {
          await disposable.dispose();
        } else if (typeof disposable.close === 'function') {
          await disposable.close();
        } else if (typeof disposable.destroy === 'function') {
          await disposable.destroy();
        }

        results.push({ key, success: true });
      } catch (error) {
        results.push({
          key,
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }

    // Clear all maps and mark registry as disposed
    this.services = {};
    this.initElapsedMs.clear();
    this.accessCounts.clear();
    this.isDisposed = true;

    return results;
  }
}
