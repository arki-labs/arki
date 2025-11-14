/**
 * Lifecycle management for graceful shutdown
 * Handles process signals and coordinates cleanup of resources
 */

type ShutdownHandler = () => Promise<void> | void;

export class LifecycleManager {
  private readonly handlers: ShutdownHandler[] = [];
  private isShuttingDown = false;
  private signalsRegistered = false;

  /**
   * Register a shutdown handler
   * Handlers are called in reverse order (LIFO) during shutdown
   */
  onShutdown(handler: ShutdownHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Execute all registered shutdown handlers
   * Returns array of results for error tracking
   */
  async shutdown(): Promise<{ index: number; success: boolean; error?: Error }[]> {
    if (this.isShuttingDown) {
      return [];
    }

    this.isShuttingDown = true;
    const results: { index: number; success: boolean; error?: Error }[] = [];

    // Execute handlers in reverse order (LIFO)
    const reversedHandlers = [...this.handlers].reverse();

    let index = 0;
    for (const handler of reversedHandlers) {
      try {
        await handler();
        results.push({ index, success: true });
      } catch (error) {
        results.push({
          index,
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
      index++;
    }

    return results;
  }

  /**
   * Register process signal handlers for graceful shutdown
   * Should be called once during application startup
   * @param exitOnComplete - Whether to exit process after shutdown (default: true)
   */
  setupSignalHandlers(exitOnComplete = true): void {
    if (this.signalsRegistered) {
      return;
    }

    this.signalsRegistered = true;

    const handleSignal = async (signal: string) => {
      console.log(`\nReceived ${signal}, starting graceful shutdown...`);

      try {
        const results = await this.shutdown();
        const failures = results.filter(r => !r.success);

        if (failures.length > 0) {
          const errorMsg = `Shutdown completed with ${failures.length} error(s): ${failures.map(f => f.error?.message).join(', ')}`;
          console.error(errorMsg);
          if (exitOnComplete) {
            process.exit(1);
          }
        } else {
          console.log('Graceful shutdown completed successfully');
          if (exitOnComplete) {
            process.exit(0);
          }
        }
      } catch (error) {
        console.error('Fatal error during shutdown:', error);
        if (exitOnComplete) {
          process.exit(1);
        }
      }
    };

    process.on('SIGTERM', () => {
      void handleSignal('SIGTERM');
    });
    process.on('SIGINT', () => {
      void handleSignal('SIGINT');
    });
  }

  /**
   * Check if shutdown is in progress
   */
  isShutdownInProgress(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Get number of registered handlers
   */
  getHandlerCount(): number {
    return this.handlers.length;
  }

  /**
   * Clear all handlers (useful for testing)
   */
  clear(): void {
    this.handlers.length = 0;
    this.isShuttingDown = false;
  }
}

/**
 * Global lifecycle manager singleton
 * Applications can import and use this directly for simple cases
 */
export const globalLifecycle = new LifecycleManager();
