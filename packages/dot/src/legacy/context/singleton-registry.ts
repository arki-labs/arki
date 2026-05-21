/* eslint-disable unicorn/prefer-switch */
import { debugContext } from '../debug.js';

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
  register<K extends keyof TServices>(key: K, service: TServices[K], elapsedMs?: number): void {
    if (this.isDisposed) {
      debugContext('[SingletonRegistry] Cannot register service %s: Registry has been disposed', String(key));
      throw new Error('Cannot register service: Registry has been disposed');
    }
    if (key in this.services) {
      debugContext('[SingletonRegistry] Cannot register service %s: Already registered', String(key));
      throw new Error(`Service '${String(key)}' is already registered`);
    }
    this.services[key] = service;
    if (elapsedMs === undefined) {
      debugContext('[SingletonRegistry] Registered service %s', String(key));
    } else {
      this.initElapsedMs.set(key, elapsedMs);
      debugContext('[SingletonRegistry] Registered service %s (initTime: %dms)', String(key), elapsedMs);
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
    factory: () => Promise<TServices[K]> | TServices[K],
  ): Promise<void> {
    debugContext('[SingletonRegistry] Starting timed registration for service %s', String(key));
    const startTime = performance.now();
    const service = await factory();
    const elapsedMs = performance.now() - startTime;
    debugContext('[SingletonRegistry] Factory for service %s completed in %dms', String(key), elapsedMs);
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
      debugContext('[SingletonRegistry] Cannot get service %s: Registry has been disposed', String(key));
      throw new Error('Cannot get service: Registry has been disposed');
    }
    if (!(key in this.services)) {
      debugContext('[SingletonRegistry] Cannot get service %s: Not registered', String(key));
      throw new Error(`Service '${String(key)}' is not registered`);
    }

    // Track access for metrics
    const count = this.accessCounts.get(key) ?? 0;
    this.accessCounts.set(key, count + 1);
    debugContext('[SingletonRegistry] Getting service %s (accessCount: %d)', String(key), count + 1);

    return this.services[key] as TServices[K];
  }

  /**
   * Check if a service is registered
   * @param key - Service identifier
   */
  has<K extends keyof TServices>(key: K): boolean {
    const exists = key in this.services;
    debugContext('[SingletonRegistry] Checking if service %s exists: %s', String(key), exists);
    return exists;
  }

  /**
   * Get all registered services
   */
  getAll(): Partial<TServices> {
    const count = Object.keys(this.services).length;
    debugContext('[SingletonRegistry] Getting all services (count: %d)', count);
    return { ...this.services };
  }

  /**
   * Get service metrics
   * @param key - Service identifier
   */
  getMetrics<K extends keyof TServices>(
    key: K,
  ): {
    initElapsedMs: number | null;
    accessCount: number;
  } {
    const initElapsedMs = this.initElapsedMs.get(key) ?? null;
    const accessCount = this.accessCounts.get(key) ?? 0;

    debugContext(
      '[SingletonRegistry] Getting metrics for service %s (initTime: %s, accessCount: %d)',
      String(key),
      initElapsedMs === null ? 'unknown' : `${initElapsedMs}ms`,
      accessCount,
    );

    return { initElapsedMs, accessCount };
  }

  /**
   * Clear all registered services without disposal
   * Useful for testing or hot reload scenarios
   */
  clear(): void {
    const count = Object.keys(this.services).length;
    debugContext('[SingletonRegistry] Clearing all services (count: %d)', count);
    this.services = {};
    this.initElapsedMs.clear();
    this.accessCounts.clear();
    debugContext('[SingletonRegistry] All services cleared');
  }

  /**
   * Dispose of all services that have a dispose/close/destroy method
   * Returns array of disposal results for error handling
   */
  async dispose(): Promise<{ key: string; success: boolean; error?: Error }[]> {
    const serviceCount = Object.keys(this.services).length;
    debugContext('[SingletonRegistry] Starting disposal of %d service(s)', serviceCount);
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
          debugContext('[SingletonRegistry] Disposing service %s using dispose() method', key);
          await disposable.dispose();
        } else if (typeof disposable.close === 'function') {
          debugContext('[SingletonRegistry] Disposing service %s using close() method', key);
          await disposable.close();
        } else if (typeof disposable.destroy === 'function') {
          debugContext('[SingletonRegistry] Disposing service %s using destroy() method', key);
          await disposable.destroy();
        } else {
          debugContext('[SingletonRegistry] Service %s has no disposal method, skipping', key);
        }

        results.push({ key, success: true });
        debugContext('[SingletonRegistry] Successfully disposed service %s', key);
      } catch (error) {
        debugContext(
          '[SingletonRegistry] Failed to dispose service %s: %s',
          key,
          error instanceof Error ? error.message : String(error),
        );
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

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;
    debugContext('[SingletonRegistry] Disposal complete (success: %d, failed: %d)', successCount, failureCount);

    return results;
  }
}
