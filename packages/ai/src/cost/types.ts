/**
 * Cost Management Types
 *
 * Generic type definitions for AI cost tracking, budget management,
 * and cost-aware circuit breaker patterns.
 *
 * @module cost/types
 */

// ============================================
// Pricing Types
// ============================================

/**
 * Pricing structure for LLM models.
 * Prices are in USD per 1,000 tokens.
 */
export interface ModelPricing {
  /** Cost per 1,000 input tokens in USD */
  inputPer1k: number;

  /** Cost per 1,000 output tokens in USD */
  outputPer1k: number;

  /** Optional: Cost per 1,000 cached input tokens (for models that support caching) */
  cachedInputPer1k?: number;
}

/**
 * Pricing for image generation models.
 * Prices are in USD per image.
 */
export interface ImagePricing {
  /** Model identifier */
  model: string;

  /** Cost per image in USD */
  costPerImage: number;

  /** Optional: Cost varies by resolution */
  resolutionPricing?: Record<string, number>;
}

/**
 * Cost estimate for a single operation.
 */
export interface CostEstimate {
  /** Description of the operation */
  operation: string;

  /** Estimated cost in USD */
  estimatedCostUsd: number;

  /** Model used for the operation */
  model: string;

  /** Token estimate (for LLM operations) */
  tokenEstimate?: {
    input: number;
    output: number;
  };
}

// ============================================
// Budget Types
// ============================================

/**
 * Standard budget periods.
 * Apps can extend this with custom periods.
 */
export type StandardBudgetPeriod = 'hourly' | 'daily' | 'weekly' | 'monthly';

/**
 * Budget period type alias for convenience.
 */
export type BudgetPeriod = StandardBudgetPeriod;

/**
 * All supported budget periods as a tuple for iteration.
 */
export const BUDGET_PERIODS = ['hourly', 'daily', 'weekly', 'monthly'] as const;

/**
 * Budget limits per period.
 */
export type BudgetLimits<TPeriod extends string = StandardBudgetPeriod> = Record<TPeriod, number>;

/**
 * Budget configuration for the budget manager.
 */
export interface BudgetConfig<TPeriod extends string = StandardBudgetPeriod> {
  /** Budget limits per period in USD */
  limits: BudgetLimits<TPeriod>;

  /** Budget periods to track (defaults to standard periods) */
  periods?: readonly TPeriod[];

  /** Key prefix for KV store (defaults to 'budget') */
  keyPrefix?: string;

  /** Duration in seconds for each period (for TTL) */
  periodDurations?: Record<TPeriod, number>;
}

/**
 * Result of a budget check operation.
 */
export interface BudgetCheckResult<TPeriod extends string = StandardBudgetPeriod> {
  /** Whether the operation is allowed */
  allowed: boolean;

  /** Reason for rejection (if not allowed) */
  rejectionReason?: string;

  /** Current spend in USD */
  currentSpendUsd: number;

  /** Remaining budget in USD */
  remainingUsd: number;

  /** Which period caused rejection (if any) */
  rejectedPeriod?: TPeriod;
}

/**
 * Metadata for a spend record.
 */
export interface SpendMetadata {
  /** Type of operation */
  operationType: string;

  /** Model used */
  model: string;

  /** Specific operation name */
  operation: string;

  /** Token counts (for LLM) */
  tokens?: {
    input: number;
    output: number;
  };

  /** Duration in milliseconds */
  durationMs?: number;

  /** Additional custom metadata */
  [key: string]: unknown;
}

/**
 * A recorded spend entry.
 */
export interface SpendRecord {
  /** Unique identifier */
  id: string;

  /** User who incurred the cost */
  userId: string;

  /** Actual cost in USD */
  costUsd: number;

  /** Operation that incurred the cost */
  operation: string;

  /** Additional metadata */
  metadata: SpendMetadata;

  /** When the spend occurred */
  timestamp: Date;
}

// ============================================
// Circuit Breaker Types
// ============================================

/**
 * Circuit breaker states.
 */
export type CircuitState = 'closed' | 'open' | 'half_open';

/**
 * All circuit states as a tuple for iteration.
 */
export const CIRCUIT_STATES = ['closed', 'open', 'half_open'] as const;

/**
 * Configuration for the cost circuit breaker.
 */
export interface CostCircuitConfig {
  /** Number of failures before opening the circuit */
  failureThreshold: number;

  /** Number of successes in half-open state before closing */
  successThreshold: number;

  /** Seconds to wait before transitioning from open to half-open */
  timeoutSeconds: number;

  /** Cost threshold in USD that triggers circuit opening */
  costThresholdUsd: number;
}

/**
 * Current state of the circuit breaker.
 */
export interface CircuitBreakerState {
  /** Current circuit state */
  state: CircuitState;

  /** Number of consecutive failures */
  failureCount: number;

  /** Number of consecutive successes (in half-open state) */
  successCount: number;

  /** When the circuit was last opened */
  lastFailureAt?: Date;

  /** When to attempt reset (transition to half-open) */
  resetAt?: Date;

  /** Cost that caused the circuit to open (if applicable) */
  triggeringCostUsd?: number;
}

/**
 * Result of a circuit breaker execution.
 */
export interface CircuitBreakerResult<T> {
  /** Whether the operation was executed */
  executed: boolean;

  /** Result of the operation (if executed successfully) */
  result?: T;

  /** Error that occurred (if any) */
  error?: Error;

  /** Whether the circuit is now open */
  circuitOpen: boolean;

  /** Reason for blocking (if not executed) */
  blockReason?: string;
}

// ============================================
// KV Store Interface
// ============================================

/**
 * Minimal KV store interface required by budget manager.
 * Compatible with @arki/kv and similar implementations.
 */
export interface KVStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
}
