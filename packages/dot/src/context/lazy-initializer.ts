/**
 * Lazy initializer for deferred service creation
 * Useful for expensive services that may not be used in every request
 */
export class LazyInitializer<T> {
  private instance: T | null = null;
  private initPromise: Promise<T> | null = null;
  private readonly factory: () => T | Promise<T>;
  private initTime: number | null = null;
  private accessCount = 0;

  constructor(factory: () => T | Promise<T>) {
    this.factory = factory;
  }

  /**
   * Get the service instance, initializing if needed
   * Thread-safe: multiple concurrent calls will await the same initialization
   */
  async get(): Promise<T> {
    this.accessCount++;

    // Return cached instance if available
    if (this.instance !== null) {
      return this.instance;
    }

    // Return in-progress initialization if another caller started it
    if (this.initPromise !== null) {
      return this.initPromise;
    }

    // Start initialization
    const startTime = Date.now();
    this.initPromise = Promise.resolve(this.factory());

    try {
      this.instance = await this.initPromise;
      this.initTime = Date.now() - startTime;
      return this.instance;
    } catch (error) {
      // Reset on failure so next caller can retry
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
      throw new Error('Service not yet initialized. Call get() first.');
    }
    return this.instance;
  }

  /**
   * Check if the service has been initialized
   */
  isInitialized(): boolean {
    return this.instance !== null;
  }

  /**
   * Get initialization metrics
   */
  getMetrics(): {
    initialized: boolean;
    initTimeMs: number | null;
    accessCount: number;
  } {
    return {
      initialized: this.instance !== null,
      initTimeMs: this.initTime,
      accessCount: this.accessCount,
    };
  }

  /**
   * Reset the initializer (useful for testing or hot reload)
   * Does not call any cleanup methods - use with caution
   */
  reset(): void {
    this.instance = null;
    this.initPromise = null;
    this.initTime = null;
    this.accessCount = 0;
  }

  /**
   * Dispose of the instance if it has a dispose/close/destroy method
   */
  async dispose(): Promise<void> {
    if (this.instance === null) {
      return;
    }

    const instance = this.instance as unknown;

    try {
      const disposable = instance as { dispose?: () => unknown; close?: () => unknown; destroy?: () => unknown };

      if (typeof disposable.dispose === 'function') {
        await disposable.dispose();
      }
      if (typeof disposable.close === 'function') {
        await disposable.close();
      }
      if (typeof disposable.destroy === 'function') {
        await disposable.destroy();
      }
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
  return new LazyInitializer(factory);
}
