/**
 * Lazy initializer for deferred service creation
 * Useful for expensive services that may not be used in every request
 */

import { debugContext } from '../debug.ts';

export class LazyInitializer<T> {
  private instance: T | null = null;
  private initPromise: Promise<T> | null = null;
  private readonly factory: () => T | Promise<T>;
  private initTime: number | null = null;
  private accessCount = 0;

  constructor(factory: () => T | Promise<T>) {
    this.factory = factory;
    debugContext('[LazyInitializer] Created new lazy initializer');
  }

  /**
   * Get the service instance, initializing if needed
   * Thread-safe: multiple concurrent calls will await the same initialization
   */
  async get(): Promise<T> {
    this.accessCount++;
    debugContext('[LazyInitializer] get() called (accessCount: %d)', this.accessCount);

    // Return cached instance if available
    if (this.instance !== null) {
      debugContext('[LazyInitializer] Returning cached instance');
      return this.instance;
    }

    // Return in-progress initialization if another caller started it
    if (this.initPromise !== null) {
      debugContext('[LazyInitializer] Awaiting in-progress initialization');
      return this.initPromise;
    }

    // Start initialization
    debugContext('[LazyInitializer] Starting lazy initialization');
    const startTime = Date.now();
    this.initPromise = Promise.resolve(this.factory());

    try {
      this.instance = await this.initPromise;
      this.initTime = Date.now() - startTime;
      debugContext('[LazyInitializer] Initialization completed in %dms', this.initTime);
      return this.instance;
    } catch (error) {
      // Reset on failure so next caller can retry
      debugContext(
        '[LazyInitializer] Initialization failed: %s',
        error instanceof Error ? error.message : String(error),
      );
      this.initPromise = null;
      throw error;
    }
  }

  /**
   * Get the instance synchronously if already initialized
   * @throws If not yet initialized
   */
  getSync(): T {
    if (this.instance === null) {
      debugContext('[LazyInitializer] getSync() called but service not initialized');
      throw new Error('Service not yet initialized. Call get() first.');
    }
    debugContext('[LazyInitializer] getSync() returning cached instance');
    return this.instance;
  }

  /**
   * Check if the service has been initialized
   */
  isInitialized(): boolean {
    const initialized = this.instance !== null;
    debugContext('[LazyInitializer] isInitialized() = %s', initialized);
    return initialized;
  }

  /**
   * Get initialization metrics
   */
  getMetrics(): {
    initialized: boolean;
    initTimeMs: number | null;
    accessCount: number;
  } {
    const metrics = {
      initialized: this.instance !== null,
      initTimeMs: this.initTime,
      accessCount: this.accessCount,
    };
    debugContext(
      '[LazyInitializer] getMetrics() (initialized: %s, initTime: %s, accessCount: %d)',
      metrics.initialized,
      metrics.initTimeMs === null ? 'unknown' : `${metrics.initTimeMs}ms`,
      metrics.accessCount,
    );
    return metrics;
  }

  /**
   * Reset the initializer (useful for testing or hot reload)
   * Does not call any cleanup methods - use with caution
   */
  reset(): void {
    debugContext('[LazyInitializer] Resetting initializer (accessCount was: %d)', this.accessCount);
    this.instance = null;
    this.initPromise = null;
    this.initTime = null;
    this.accessCount = 0;
    debugContext('[LazyInitializer] Reset complete');
  }

  /**
   * Dispose of the instance if it has a dispose/close/destroy method
   */
  async dispose(): Promise<void> {
    if (this.instance === null) {
      debugContext('[LazyInitializer] dispose() called but instance not initialized, nothing to dispose');
      return;
    }

    debugContext('[LazyInitializer] Starting disposal');
    const instance = this.instance as unknown;

    try {
      const disposable = instance as { dispose?: () => unknown; close?: () => unknown; destroy?: () => unknown };

      if (typeof disposable.dispose === 'function') {
        debugContext('[LazyInitializer] Calling dispose() method');
        await disposable.dispose();
      }
      if (typeof disposable.close === 'function') {
        debugContext('[LazyInitializer] Calling close() method');
        await disposable.close();
      }
      if (typeof disposable.destroy === 'function') {
        debugContext('[LazyInitializer] Calling destroy() method');
        await disposable.destroy();
      }
      debugContext('[LazyInitializer] Disposal complete');
    } finally {
      this.reset();
    }
  }
}

/**
 * Create a lazy initializer for a service
 * Syntactic sugar for new LazyInitializer(factory)
 */
export function lazy<T>(factory: () => T | Promise<T>): LazyInitializer<T> {
  debugContext('[lazy] Creating new lazy initializer via factory function');
  return new LazyInitializer(factory);
}
