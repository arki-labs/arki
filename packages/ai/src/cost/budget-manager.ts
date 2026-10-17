/**
 * Budget Manager
 *
 * Generic budget tracking and enforcement for LLM operations.
 * Uses a KV store for persistence across multiple periods.
 *
 * @module cost/budget-manager
 */

import { BudgetExceeded } from '../failures';
import type {
  BudgetConfig,
  BudgetLimits,
  BudgetPeriod,
  KVStore,
  SpendMetadata,
  SpendRecord,
} from './types';

// ============================================
// Constants
// ============================================

/**
 * Standard budget periods with their durations in seconds.
 */
export const BUDGET_PERIOD_DURATIONS = {
  hourly: 3600,
  daily: 86_400,
  monthly: 2_592_000, // 30 days
} as const;

/**
 * Conservative default limits (in USD).
 * Applications should override these based on their needs.
 */
export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  hourly: 1,
  daily: 10,
  weekly: 50,
  monthly: 100,
};

// ============================================
// Budget Manager Class
// ============================================

/**
 * Manages user budgets across multiple time periods.
 *
 * Provides budget checking, spend recording, and enforcement
 * using a pluggable KV store for persistence.
 *
 * @example
 * ```typescript
 * const budgetManager = new BudgetManager(kvStore, {
 *   limits: { hourly: 5, daily: 50, monthly: 500 },
 *   keyPrefix: 'myapp:budget',
 * });
 *
 * // Check if operation is within budget
 * const exceeded = await budgetManager.checkBudget(userId, estimatedCost);
 * if (BudgetExceeded.is(exceeded)) return exceeded;
 *
 * // Record actual spend after operation
 * await budgetManager.recordSpend(userId, actualCost, metadata);
 * ```
 */
export class BudgetManager<TPeriod extends string = BudgetPeriod> {
  private readonly kv: KVStore;
  private readonly limits: Record<TPeriod, number>;
  private readonly periods: readonly TPeriod[];
  private readonly keyPrefix: string;
  private readonly periodDurations: Record<TPeriod, number>;

  constructor(kv: KVStore, config: BudgetConfig<TPeriod>) {
    this.kv = kv;
    this.limits = config.limits;
    this.periods = config.periods ?? (['hourly', 'daily', 'monthly'] as unknown as TPeriod[]);
    this.keyPrefix = config.keyPrefix ?? 'budget';
    this.periodDurations = config.periodDurations ?? (BUDGET_PERIOD_DURATIONS as Record<TPeriod, number>);
  }

  // ============================================
  // Budget Checking
  // ============================================

  /**
   * Check if a user has sufficient budget for an operation.
   *
   * An exhausted budget is an answer the caller must branch on, so it is returned, not thrown.
   *
   * @param userId - User identifier
   * @param estimatedCostUsd - Estimated cost in USD
   * @returns Nothing when every period has room, or `BudgetExceeded` for the first period that would be exceeded
   */
  async checkBudget(userId: string, estimatedCostUsd: number): Promise<BudgetExceeded | undefined> {
    // Get current spend across all periods
    const spends = await Promise.all(
      this.periods.map(async period => ({
        period,
        currentSpend: await this.getCurrentSpend(userId, period),
        limit: this.limits[period],
      }))
    );

    for (const { period, currentSpend, limit } of spends) {
      // Check if any period would be exceeded
      if (currentSpend + estimatedCostUsd > limit) {
        return BudgetExceeded({
          period: String(period),
          currentSpendUsd: currentSpend,
          remainingUsd: Math.max(0, limit - currentSpend),
        });
      }
    }

    // All periods OK
    return;
  }

  /**
   * Get the remaining budget for a user.
   *
   * @param userId - User identifier
   * @returns Minimum remaining budget across all periods (in USD)
   */
  async getRemainingBudget(userId: string): Promise<number> {
    const spends = await Promise.all(
      this.periods.map(async period => {
        const currentSpend = await this.getCurrentSpend(userId, period);
        return this.limits[period] - currentSpend;
      })
    );

    return Math.max(0, Math.min(...spends));
  }

  // ============================================
  // Spend Recording
  // ============================================

  /**
   * Record a spend for a user.
   *
   * @param userId - User identifier
   * @param costUsd - Cost in USD
   * @param metadata - Optional spend metadata
   */
  async recordSpend(userId: string, costUsd: number, metadata?: SpendMetadata): Promise<void> {
    // Record spend for each budget period
    await Promise.all(
      this.periods.map(period => this.addSpend(userId, period, costUsd))
    );

    // Optionally store the spend record for auditing
    if (metadata) {
      await this.storeSpendRecord(userId, costUsd, metadata);
    }
  }

  /**
   * Get current spend for a user in a specific period.
   *
   * @param userId - User identifier
   * @param period - Budget period
   * @returns Current spend in USD
   */
  async getCurrentSpend(userId: string, period: TPeriod): Promise<number> {
    const key = this.getSpendKey(userId, period);
    const spend = await this.kv.get<number>(key);
    return spend ?? 0;
  }

  /**
   * Get spend breakdown across all periods.
   *
   * @param userId - User identifier
   * @returns Spend by period
   */
  async getSpendBreakdown(userId: string): Promise<Record<TPeriod, number>> {
    const breakdown = {} as Record<TPeriod, number>;

    await Promise.all(
      this.periods.map(async period => {
        breakdown[period] = await this.getCurrentSpend(userId, period);
      })
    );

    return breakdown;
  }

  // ============================================
  // Budget Management
  // ============================================

  /**
   * Reset budget for a user in a specific period.
   *
   * @param userId - User identifier
   * @param period - Budget period to reset
   */
  async resetPeriod(userId: string, period: TPeriod): Promise<void> {
    const key = this.getSpendKey(userId, period);
    await this.kv.delete(key);
  }

  /**
   * Reset all budgets for a user.
   *
   * @param userId - User identifier
   */
  async resetAllPeriods(userId: string): Promise<void> {
    await Promise.all(
      this.periods.map(period => this.resetPeriod(userId, period))
    );
  }

  /**
   * Get budget status for display purposes.
   *
   * @param userId - User identifier
   * @returns Budget status with percentages
   */
  async getBudgetStatus(userId: string): Promise<
    {
      period: TPeriod;
      spent: number;
      limit: number;
      remaining: number;
      percentUsed: number;
    }[]
  > {
    const breakdown = await this.getSpendBreakdown(userId);

    return this.periods.map(period => {
      const spent = breakdown[period];
      const limit = this.limits[period];
      const remaining = Math.max(0, limit - spent);
      const percentUsed = (spent / limit) * 100;

      return {
        period,
        spent,
        limit,
        remaining,
        percentUsed: Math.min(100, percentUsed),
      };
    });
  }

  // ============================================
  // Internal Methods
  // ============================================

  private getSpendKey(userId: string, period: TPeriod): string {
    return `${this.keyPrefix}:${userId}:${String(period)}`;
  }

  private getRecordKey(userId: string, timestamp: number): string {
    return `${this.keyPrefix}:record:${userId}:${timestamp}`;
  }

  private async addSpend(userId: string, period: TPeriod, costUsd: number): Promise<void> {
    const key = this.getSpendKey(userId, period);
    const current = await this.getCurrentSpend(userId, period);
    const ttl = this.periodDurations[period];

    await this.kv.set(key, current + costUsd, ttl);
  }

  private async storeSpendRecord(
    userId: string,
    costUsd: number,
    metadata: SpendMetadata
  ): Promise<void> {
    const timestamp = Date.now();
    const key = this.getRecordKey(userId, timestamp);

    const record: SpendRecord = {
      id: `spend_${timestamp}_${Math.random().toString(36).slice(2, 11)}`,
      userId,
      costUsd,
      operation: metadata.operation,
      metadata,
      timestamp: new Date(timestamp),
    };

    // Store for 30 days for auditing
    await this.kv.set(key, record, 30 * 24 * 3600);
  }
}

// ============================================
// Factory Function
// ============================================

/**
 * Create a BudgetManager with default configuration.
 *
 * @param kv - KV store instance
 * @param options - Optional configuration overrides
 * @returns Configured BudgetManager
 */
export function createBudgetManager(
  kv: KVStore,
  options?: Partial<BudgetConfig>
): BudgetManager {
  return new BudgetManager(kv, {
    limits: options?.limits ?? DEFAULT_BUDGET_LIMITS,
    periods: options?.periods ?? ['hourly', 'daily', 'monthly'],
    keyPrefix: options?.keyPrefix ?? 'budget',
  });
}
