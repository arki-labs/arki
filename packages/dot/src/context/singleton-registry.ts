/* eslint-disable unicorn/prefer-switch */
/**
 * Generic singleton service registry for expensive-to-initialize services
 * Provides lifecycle management with registration, retrieval, and disposal
 */
export class SingletonServicesRegistry<TServices extends Record<string, unknown>> {
  private services: Partial<TServices> = {};
  private readonly initTimestamps = new Map<keyof TServices, number>();
  private readonly accessCounts = new Map<keyof TServices, number>();

  /**
   * Register a service in the singleton registry
   * @param key - Service identifier
   * @param service - Service instance
   */
  register<K extends keyof TServices>(key: K, service: TServices[K]): void {
    if (key in this.services) {
      throw new Error(`Service '${String(key)}' is already registered`);
    }
    this.services[key] = service;
    this.initTimestamps.set(key, Date.now());
    this.accessCounts.set(key, 0);
  }

  /**
   * Get a registered service
   * @param key - Service identifier
   * @returns The service instance
   * @throws If service is not registered
   */
  get<K extends keyof TServices>(key: K): TServices[K] {
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
    initTime: number | null;
    accessCount: number;
    ageMs: number | null;
  } {
    const initTime = this.initTimestamps.get(key) ?? null;
    const accessCount = this.accessCounts.get(key) ?? 0;
    const ageMs = initTime ? Date.now() - initTime : null;

    return { initTime, accessCount, ageMs };
  }

  /**
   * Clear all registered services without disposal
   * Useful for testing or hot reload scenarios
   */
  clear(): void {
    this.services = {};
    this.initTimestamps.clear();
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

    return results;
  }
}
