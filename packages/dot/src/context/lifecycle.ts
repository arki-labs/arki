/**
 * Lifecycle management for graceful shutdown
 * Handles process signals and coordinates cleanup of resources
 */

import { debugContext } from '../debug.ts';

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
    debugContext('[LifecycleManager] Registered shutdown handler (total: %d)', this.handlers.length);
  }

  /**
   * Execute all registered shutdown handlers
   * Returns array of results for error tracking
   */
  async shutdown(): Promise<{ index: number; success: boolean; error?: Error }[]> {
    if (this.isShuttingDown) {
      debugContext('[LifecycleManager] Shutdown already in progress, ignoring duplicate call');
      return [];
    }

    this.isShuttingDown = true;
    debugContext('[LifecycleManager] Starting shutdown sequence with %d handler(s)', this.handlers.length);
    const results: { index: number; success: boolean; error?: Error }[] = [];

    // Execute handlers in reverse order (LIFO)
    const reversedHandlers = [...this.handlers].reverse();

    let index = 0;
    for (const handler of reversedHandlers) {
      try {
        debugContext('[LifecycleManager] Executing shutdown handler %d/%d', index + 1, reversedHandlers.length);
        await handler();
        results.push({ index, success: true });
        debugContext('[LifecycleManager] Shutdown handler %d completed successfully', index + 1);
      } catch (error) {
        debugContext(
          '[LifecycleManager] Shutdown handler %d failed: %s',
          index + 1,
          error instanceof Error ? error.message : String(error),
        );
        results.push({
          index,
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
      index++;
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;
    debugContext('[LifecycleManager] Shutdown complete (success: %d, failed: %d)', successCount, failureCount);

    return results;
  }

  /**
   * Register process signal handlers for graceful shutdown
   * Should be called once during application startup
   * @param exitOnComplete - Whether to exit process after shutdown (default: true)
   */
  setupSignalHandlers(exitOnComplete = true): void {
    if (this.signalsRegistered) {
      debugContext('[LifecycleManager] Signal handlers already registered, skipping');
      return;
    }

    this.signalsRegistered = true;
    debugContext('[LifecycleManager] Setting up signal handlers (exitOnComplete: %s)', exitOnComplete);

    const handleSignal = async (signal: string) => {
      debugContext('[LifecycleManager] Received signal: %s', signal);
      console.log(`\nReceived ${signal}, starting graceful shutdown...`);

      try {
        const results = await this.shutdown();
        const failures = results.filter(r => !r.success);

        if (failures.length > 0) {
          const errorMsg = `Shutdown completed with ${failures.length} error(s): ${failures.map(f => f.error?.message).join(', ')}`;
          console.error(errorMsg);
          debugContext('[LifecycleManager] Shutdown completed with errors, exiting with code 1');
          if (exitOnComplete) {
            process.exit(1);
          }
        } else {
          console.log('Graceful shutdown completed successfully');
          debugContext('[LifecycleManager] Shutdown completed successfully, exiting with code 0');
          if (exitOnComplete) {
            process.exit(0);
          }
        }
      } catch (error) {
        console.error('Fatal error during shutdown:', error);
        debugContext(
          '[LifecycleManager] Fatal error during shutdown: %s',
          error instanceof Error ? error.message : String(error),
        );
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
    debugContext('[LifecycleManager] Signal handlers registered for SIGTERM and SIGINT');
  }

  /**
   * Check if shutdown is in progress
   */
  isShutdownInProgress(): boolean {
    debugContext('[LifecycleManager] Checking shutdown status: %s', this.isShuttingDown);
    return this.isShuttingDown;
  }

  /**
   * Get number of registered handlers
   */
  getHandlerCount(): number {
    debugContext('[LifecycleManager] Getting handler count: %d', this.handlers.length);
    return this.handlers.length;
  }

  /**
   * Clear all handlers (useful for testing)
   */
  clear(): void {
    const count = this.handlers.length;
    this.handlers.length = 0;
    this.isShuttingDown = false;
    debugContext('[LifecycleManager] Cleared %d handler(s) and reset shutdown state', count);
  }
}

/**
 * Global lifecycle manager singleton
 * Applications can import and use this directly for simple cases
 */
export const globalLifecycle = new LifecycleManager();
