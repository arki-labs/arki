/**
 * Transaction Manager for batch operations
 * Provides rollback support for failed operations
 */

import { VectorSearchError, getErrorMessage } from '../errors';

export type TransactionOperation<T = unknown> = {
  name: string;
  execute: () => Promise<T>;
  rollback?: () => Promise<void>;
}

export type TransactionResult<T = unknown> = {
  success: boolean;
  results?: T[];
  error?: Error;
  rollbackResults?: { name: string; success: boolean; error?: Error }[];
}

export class TransactionManager {
  private executedOperations: {
    operation: TransactionOperation;
    result: unknown;
  }[] = [];

  /**
   * Execute a batch of operations with automatic rollback on failure
   */
  async executeTransaction<T>(
    operations: TransactionOperation<T>[]
  ): Promise<TransactionResult<T>> {
    const results: T[] = [];
    this.executedOperations = [];

    try {
      // Execute all operations in sequence
      for (const operation of operations) {
        try {
          const result = await operation.execute();
          results.push(result);
          this.executedOperations.push({ operation, result });
        } catch (error) {
          // Operation failed, trigger rollback
          const rollbackResults = await this.rollback();
          return {
            success: false,
            error: new VectorSearchError(
              `Transaction failed at operation '${operation.name}': ${getErrorMessage(error)}`,
              error
            ),
            rollbackResults,
          };
        }
      }

      // All operations succeeded
      return {
        success: true,
        results,
      };
    } catch (error) {
      // Unexpected error during transaction
      const rollbackResults = await this.rollback();
      return {
        success: false,
        error: new VectorSearchError(
          `Transaction failed unexpectedly: ${getErrorMessage(error)}`,
          error
        ),
        rollbackResults,
      };
    } finally {
      this.executedOperations = [];
    }
  }

  /**
   * Execute operations in parallel with all-or-nothing semantics
   */
  async executeParallelTransaction<T>(
    operations: TransactionOperation<T>[]
  ): Promise<TransactionResult<T>> {
    try {
      // Execute all operations in parallel
      const results = await Promise.all(
        operations.map(op => op.execute())
      );

      // Track executed operations for potential rollback
      for (const [index, operation] of operations.entries()) {
        this.executedOperations.push({ operation, result: results[index] });
      }

      return {
        success: true,
        results,
      };
    } catch (error) {
      // One or more operations failed, trigger rollback
      const rollbackResults = await this.rollback();
      return {
        success: false,
        error: new VectorSearchError(
          `Parallel transaction failed: ${getErrorMessage(error)}`,
          error
        ),
        rollbackResults,
      };
    } finally {
      this.executedOperations = [];
    }
  }

  /**
   * Rollback executed operations in reverse order
   */
  private async rollback(): Promise<{ name: string; success: boolean; error?: Error }[]> {
    const rollbackResults: { name: string; success: boolean; error?: Error }[] = [];

    // Rollback in reverse order
    for (let i = this.executedOperations.length - 1; i >= 0; i--) {
      const { operation } = this.executedOperations[i]!;

      if (operation.rollback) {
        try {
          await operation.rollback();
          rollbackResults.push({
            name: operation.name,
            success: true,
          });
        } catch (error) {
          rollbackResults.push({
            name: operation.name,
            success: false,
            error: error as Error,
          });
        }
      }
    }

    return rollbackResults;
  }

  /**
   * Create a checkpoint for manual rollback control
   */
  createCheckpoint(): number {
    return this.executedOperations.length;
  }

  /**
   * Rollback to a specific checkpoint
   */
  async rollbackToCheckpoint(checkpoint: number): Promise<void> {
    while (this.executedOperations.length > checkpoint) {
      const { operation } = this.executedOperations.pop()!;
      if (operation.rollback) {
        await operation.rollback();
      }
    }
  }
}

/**
 * Helper function to create a transactional batch operation
 */
export function createBatchTransaction<T>(
  items: T[],
  processItem: (item: T, index: number) => Promise<unknown>,
  rollbackItem?: (item: T, index: number) => Promise<void>
): TransactionOperation[] {
  return items.map((item, index) => ({
    name: `Batch item ${index + 1}`,
    execute: () => processItem(item, index),
    rollback: rollbackItem ? () => rollbackItem(item, index) : undefined,
  }));
}